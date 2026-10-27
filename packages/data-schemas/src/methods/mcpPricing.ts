import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { getTenantId, runAsSystem, tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

/**
 * Monthly prices of the platform's MCP servers and the tenants' subscriptions to them
 * (fork-only).
 *
 * - `PlatformMcpPrice` (platform-wide, no tenant): the operator's monthly price of one server in
 *   the display currency. No document, or a price of 0, means the server is free.
 * - `McpSubscription` (tenant-isolated): one tenant admin's consent to a server's price, with
 *   the periods the server was on. A month is charged once for each subscription that was active
 *   at any time in it, at the price accepted. Ending a subscription keeps the month charged;
 *   resuming it in the same month costs nothing extra. Months are calendar months in UTC.
 *
 * A priced server without an active subscription is off for the tenant (`isMcpServerUnpaid`).
 * That check runs on every MCP server lookup, so prices and active subscriptions are held in
 * memory and reloaded at most every `refreshMs`; writes through these methods update the copy
 * at once.
 */

/** Servers that are always free and can never be priced: the platform's support server. */
export const FREE_MCP_SERVERS: ReadonlySet<string> = new Set(['support']);

export interface McpServerPrice {
  server: string;
  /** Per tenant and month, in `currency`. */
  monthlyPrice: number;
  /** ISO 4217 code of the display currency when the price was set. */
  currency: string;
  updatedAt?: Date;
}

export interface McpSubscriptionPeriod {
  start: Date;
  /** Absent while the period is running. */
  end?: Date;
}

export interface McpSubscription {
  id: string;
  tenantId: string;
  server: string;
  /** The monthly price the tenant accepted. */
  price: number;
  currency: string;
  acceptedBy: { id: string; name?: string };
  acceptedAt: Date;
  periods: McpSubscriptionPeriod[];
  active: boolean;
}

/** One subscription's fixed charges in a period. */
export interface McpCharge {
  server: string;
  price: number;
  currency: string;
  /** `YYYY-MM`, oldest first. */
  months: string[];
}

export type McpPriceResult =
  | { ok: true; value: McpServerPrice }
  | { ok: false; error: { code: 'always_free' } };

export type McpSubscribeErrorCode =
  | 'always_free'
  | 'not_priced'
  | 'consent_required'
  | 'price_changed';

export type McpSubscribeResult =
  | {
      ok: true;
      value: { subscription: McpSubscription; change: 'created' | 'resumed' | 'unchanged' };
    }
  | {
      ok: false;
      error: {
        code: McpSubscribeErrorCode;
        /** The current price, for `price_changed`. */
        price?: { monthlyPrice: number; currency: string };
      };
    };

export interface McpSubscribeInput {
  tenantId: string;
  server: string;
  /** The price the admin was shown and agreed to; not needed to resume within a charged month. */
  consent?: { monthlyPrice: number; currency: string };
  acceptedBy: { id: string; name?: string };
  now?: Date;
}

export interface McpPricingMethods {
  listMcpServerPrices(): Promise<McpServerPrice[]>;
  /** Sets a server's monthly price; a free server is refused. Subscriptions keep their price. */
  setMcpServerPrice(price: Omit<McpServerPrice, 'updatedAt'>): Promise<McpPriceResult>;
  /** Makes a server free again and ends its running subscriptions; returns those it ended. */
  deleteMcpServerPrice(
    server: string,
    now?: Date,
  ): Promise<{ removed: boolean; ended: McpSubscription[] }>;
  /** Reloads the in-memory prices and active subscriptions. */
  loadMcpPricing(): Promise<void>;
  /**
   * Whether `server` is priced and the tenant (the caller's by default) has no active
   * subscription to it, from the in-memory copy. False without a tenant and for free servers.
   */
  isMcpServerUnpaid(server: string, tenantId?: string): boolean;
  /** A tenant's subscriptions, or every tenant's without one; newest first. */
  listMcpSubscriptions(tenantId?: string): Promise<McpSubscription[]>;
  subscribeMcpServer(input: McpSubscribeInput): Promise<McpSubscribeResult>;
  /** Ends the running period; null when the server had no active subscription. */
  unsubscribeMcpServer(input: {
    tenantId: string;
    server: string;
    now?: Date;
  }): Promise<McpSubscription | null>;
  /** The months charged between two days (`YYYY-MM-DD`, inclusive), per subscription. */
  listMcpCharges(input: {
    tenantId: string;
    from: string;
    to: string;
    now?: Date;
  }): Promise<McpCharge[]>;
}

/** `YYYY-MM` of a date in UTC. */
export function billingMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function nextMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** Every month a subscription's periods touch, oldest first; a running period runs to `now`. */
export function chargedMonths(periods: McpSubscriptionPeriod[], now: Date): string[] {
  const months = new Set<string>();
  for (const period of periods) {
    const last = billingMonth(period.end ?? now);
    for (let month = billingMonth(period.start); month <= last; month = nextMonth(month)) {
      months.add(month);
    }
  }
  return [...months].sort();
}

/** Prices are compared to the cent. */
const cents = (amount: number) => Math.round(amount * 100);

/**
 * The months charged between two days (`YYYY-MM-DD`, inclusive) for a tenant's subscriptions:
 * every month a subscription was active in, once per server (by its oldest subscription), at
 * the price accepted. Sorted by server, then month.
 */
export function mcpChargesBetween(
  subscriptions: Pick<
    McpSubscription,
    'server' | 'price' | 'currency' | 'periods' | 'acceptedAt'
  >[],
  from: string,
  to: string,
  now: Date,
): McpCharge[] {
  const first = from.slice(0, 7);
  const last = to.slice(0, 7);
  const seen = new Set<string>();
  const charges: McpCharge[] = [];
  const oldestFirst = [...subscriptions].sort(
    (a, b) => new Date(a.acceptedAt).getTime() - new Date(b.acceptedAt).getTime(),
  );
  for (const subscription of oldestFirst) {
    const key = (month: string) => `${subscription.server}\u0000${month}`;
    const months = chargedMonths(subscription.periods ?? [], now).filter(
      (month) => month >= first && month <= last && !seen.has(key(month)),
    );
    months.forEach((month) => seen.add(key(month)));
    if (months.length > 0) {
      const { server, price, currency } = subscription;
      charges.push({ server, price, currency, months });
    }
  }
  return charges.sort(
    (a, b) =>
      a.server.localeCompare(b.server) || (a.months[0] ?? '').localeCompare(b.months[0] ?? ''),
  );
}

const priceSchema = new Schema<McpServerPrice>(
  {
    server: { type: String, required: true, unique: true },
    monthlyPrice: { type: Number, required: true, min: 0, max: 100_000 },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
  },
  { timestamps: true },
);

interface StoredSubscription extends Omit<McpSubscription, 'id'> {
  _id: { toString(): string };
}

const periodSchema = new Schema<McpSubscriptionPeriod>(
  { start: { type: Date, required: true }, end: { type: Date } },
  { _id: false },
);

const subscriptionSchema = new Schema<StoredSubscription>(
  {
    tenantId: { type: String, required: true },
    server: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    acceptedBy: {
      id: { type: String, required: true },
      name: { type: String },
    },
    acceptedAt: { type: Date, required: true },
    periods: { type: [periodSchema], default: [] },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);
subscriptionSchema.index({ tenantId: 1, server: 1, acceptedAt: -1 });
/** At most one running subscription per tenant and server. */
subscriptionSchema.index(
  { tenantId: 1, server: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

function toPrice(doc: McpServerPrice): McpServerPrice {
  return {
    server: doc.server,
    monthlyPrice: doc.monthlyPrice,
    currency: doc.currency,
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

function toSubscription(doc: StoredSubscription): McpSubscription {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    server: doc.server,
    price: doc.price,
    currency: doc.currency,
    acceptedBy: {
      id: doc.acceptedBy.id,
      ...(doc.acceptedBy.name && { name: doc.acceptedBy.name }),
    },
    acceptedAt: doc.acceptedAt,
    periods: (doc.periods ?? []).map((p) => ({ start: p.start, ...(p.end && { end: p.end }) })),
    active: doc.active === true,
  };
}

const isDuplicateKey = (error: unknown) => (error as { code?: unknown })?.code === 11000;

export function createMcpPricingMethods(
  mongoose: typeof import('mongoose'),
  options: { refreshMs?: number; now?: () => number } = {},
): McpPricingMethods {
  applyTenantIsolation(subscriptionSchema);
  const Price: Model<McpServerPrice> =
    mongoose.models.PlatformMcpPrice ||
    mongoose.model<McpServerPrice>('PlatformMcpPrice', priceSchema);
  const Subscription: Model<StoredSubscription> =
    mongoose.models.McpSubscription ||
    mongoose.model<StoredSubscription>('McpSubscription', subscriptionSchema);
  const refreshMs = options.refreshMs ?? 60_000;
  const clock = options.now ?? Date.now;

  /** Queries also name the tenant, so they hold without strict isolation too. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);

  let prices = new Map<string, McpServerPrice>();
  /** Servers with an active subscription, per tenant. */
  let active = new Map<string, Set<string>>();
  let loadedAt = -Infinity;
  let loading: Promise<void> | null = null;

  const markActive = (tenantId: string, server: string, on: boolean) => {
    const servers = active.get(tenantId) ?? new Set<string>();
    if (on) servers.add(server);
    else servers.delete(server);
    active.set(tenantId, servers);
  };

  async function loadMcpPricing(): Promise<void> {
    const [priceDocs, subscriptionDocs] = await Promise.all([
      Price.find({}).lean<McpServerPrice[]>(),
      runAsSystem(async () =>
        Subscription.find({ active: true }, { tenantId: 1, server: 1 }).lean<
          Pick<StoredSubscription, 'tenantId' | 'server'>[]
        >(),
      ),
    ]);
    const byTenant = new Map<string, Set<string>>();
    for (const doc of subscriptionDocs) {
      const servers = byTenant.get(doc.tenantId) ?? new Set<string>();
      servers.add(doc.server);
      byTenant.set(doc.tenantId, servers);
    }
    prices = new Map(priceDocs.map((doc) => [doc.server, toPrice(doc)]));
    active = byTenant;
    loadedAt = clock();
  }

  /** Starts a reload when the copy is stale; the caller keeps using the current copy. */
  function refreshIfStale(): void {
    if (loading || clock() - loadedAt < refreshMs) {
      return;
    }
    loading = loadMcpPricing()
      .catch(() => {
        // Keep the last copy; the next stale read tries again.
        loadedAt = clock();
      })
      .finally(() => {
        loading = null;
      });
  }

  const listInTenant = (tenantId: string, server?: string) =>
    inTenant(tenantId, async () =>
      Subscription.find({ tenantId, ...(server && { server }) })
        .sort({ acceptedAt: -1 })
        .lean<StoredSubscription[]>(),
    );

  async function endRunning(tenantId: string, server: string, now: Date) {
    const doc = await inTenant(tenantId, async () =>
      Subscription.findOneAndUpdate(
        { tenantId, server, active: true },
        { $set: { active: false, 'periods.$[open].end': now } },
        { new: true, arrayFilters: [{ 'open.end': { $exists: false } }] },
      ).lean<StoredSubscription>(),
    );
    markActive(tenantId, server, false);
    return doc ? toSubscription(doc) : null;
  }

  async function subscribe({
    tenantId,
    server,
    consent,
    acceptedBy,
    now = new Date(clock()),
  }: McpSubscribeInput): Promise<McpSubscribeResult> {
    if (FREE_MCP_SERVERS.has(server)) {
      return { ok: false, error: { code: 'always_free' } };
    }
    const priceDoc = await Price.findOne({ server }).lean<McpServerPrice>();
    if (!priceDoc || priceDoc.monthlyPrice <= 0) {
      return { ok: false, error: { code: 'not_priced' } };
    }
    const current = { monthlyPrice: priceDoc.monthlyPrice, currency: priceDoc.currency };
    const existing = await listInTenant(tenantId, server);
    const running = existing.find((doc) => doc.active);
    if (running) {
      markActive(tenantId, server, true);
      return { ok: true, value: { subscription: toSubscription(running), change: 'unchanged' } };
    }

    // The month of the last period is charged already: switching back on costs nothing.
    const latest = existing[0];
    const lastEnd = latest?.periods[latest.periods.length - 1]?.end;
    if (latest && lastEnd && billingMonth(lastEnd) === billingMonth(now)) {
      try {
        const resumed = await inTenant(tenantId, async () =>
          Subscription.findOneAndUpdate(
            { _id: latest._id, tenantId, active: false },
            { $set: { active: true }, $push: { periods: { start: now } } },
            { new: true },
          ).lean<StoredSubscription>(),
        );
        if (resumed) {
          markActive(tenantId, server, true);
          return {
            ok: true,
            value: { subscription: toSubscription(resumed), change: 'resumed' },
          };
        }
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      return subscribe({ tenantId, server, consent, acceptedBy, now });
    }

    if (!consent) {
      return { ok: false, error: { code: 'consent_required', price: current } };
    }
    if (
      cents(consent.monthlyPrice) !== cents(current.monthlyPrice) ||
      consent.currency !== current.currency
    ) {
      return { ok: false, error: { code: 'price_changed', price: current } };
    }
    try {
      const created = await inTenant(tenantId, async () =>
        Subscription.create({
          tenantId,
          server,
          price: current.monthlyPrice,
          currency: current.currency,
          acceptedBy,
          acceptedAt: now,
          periods: [{ start: now }],
          active: true,
        }),
      );
      markActive(tenantId, server, true);
      return {
        ok: true,
        value: {
          subscription: toSubscription(created.toObject() as StoredSubscription),
          change: 'created',
        },
      };
    } catch (error) {
      // Another request subscribed at the same moment: that subscription stands.
      if (!isDuplicateKey(error)) throw error;
      const winner = (await listInTenant(tenantId, server)).find((doc) => doc.active);
      if (!winner) throw error;
      markActive(tenantId, server, true);
      return { ok: true, value: { subscription: toSubscription(winner), change: 'unchanged' } };
    }
  }

  return {
    async listMcpServerPrices() {
      const docs = await Price.find({}).sort({ server: 1 }).lean<McpServerPrice[]>();
      return docs.map(toPrice);
    },

    async setMcpServerPrice({ server, monthlyPrice, currency }) {
      if (FREE_MCP_SERVERS.has(server)) {
        return { ok: false, error: { code: 'always_free' } };
      }
      const doc = await Price.findOneAndUpdate(
        { server },
        { $set: { server, monthlyPrice, currency } },
        { upsert: true, new: true, runValidators: true },
      ).lean<McpServerPrice>();
      const saved = toPrice(doc as McpServerPrice);
      prices.set(server, saved);
      return { ok: true, value: saved };
    },

    async deleteMcpServerPrice(server, now = new Date(clock())) {
      const { deletedCount } = await Price.deleteOne({ server });
      prices.delete(server);
      const running = await runAsSystem(async () =>
        Subscription.find({ server, active: true }, { tenantId: 1 }).lean<
          Pick<StoredSubscription, 'tenantId'>[]
        >(),
      );
      const ended: McpSubscription[] = [];
      for (const { tenantId } of running) {
        const subscription = await endRunning(tenantId, server, now);
        if (subscription) ended.push(subscription);
      }
      return { removed: deletedCount > 0, ended };
    },

    loadMcpPricing,

    isMcpServerUnpaid(server, tenantId = getTenantId()) {
      refreshIfStale();
      const price = prices.get(server);
      if (!price || price.monthlyPrice <= 0 || FREE_MCP_SERVERS.has(server)) {
        return false;
      }
      if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
        return false;
      }
      return active.get(tenantId)?.has(server) !== true;
    },

    async listMcpSubscriptions(tenantId) {
      const docs = tenantId
        ? await listInTenant(tenantId)
        : await runAsSystem(async () =>
            Subscription.find({})
              .sort({ tenantId: 1, server: 1, acceptedAt: -1 })
              .lean<StoredSubscription[]>(),
          );
      return docs.map(toSubscription);
    },

    subscribeMcpServer: subscribe,

    unsubscribeMcpServer({ tenantId, server, now = new Date(clock()) }) {
      return endRunning(tenantId, server, now);
    },

    async listMcpCharges({ tenantId, from, to, now = new Date(clock()) }) {
      const docs = await listInTenant(tenantId);
      return mcpChargesBetween(docs, from, to, now);
    },
  };
}
