import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { SYSTEM_TENANT_ID } from '~/config/tenantContext';

/**
 * The platform operator's prices (fork-only): a markup on every model's token rates and a price
 * for web searches, as a platform default with optional overrides per tenant, and the currency
 * prices are shown in. Rates stay USD-based credits (1,000,000 credits = 1 USD); the markup
 * scales them, so balances, balance checks and the costs shown in chat all carry it.
 *
 * Documents live platform-wide, without a tenant: `scope` is `default` or a tenant id. Token
 * rates are resolved synchronously, so the documents are held in memory and reloaded at most
 * every `refreshMs`; a write through these methods updates the copy at once.
 */

export const DEFAULT_PRICING_SCOPE = 'default';

export interface PricingCurrency {
  /** ISO 4217 code, e.g. `EUR`. */
  code: string;
  /** Units of the currency per USD. */
  rate: number;
}

export interface PlatformPricing {
  scope: string;
  /** Fraction added to token rates: 0.15 charges 115 %. */
  tokenMarkup?: number;
  /** Price of 1,000 web searches in the display currency. */
  searchPer1000?: number;
  /** Display currency; the default document's applies to every tenant. */
  currency?: PricingCurrency;
  updatedAt?: Date;
}

/** What applies to one tenant, after its override and the platform default. */
export interface ResolvedPricing {
  tokenMarkup: number;
  searchPer1000: number;
  currency?: PricingCurrency;
}

export interface PlatformPricingMethods {
  listPlatformPricing(): Promise<PlatformPricing[]>;
  /** Replaces the scope's document; fields left out no longer apply. */
  setPlatformPricing(pricing: PlatformPricing): Promise<PlatformPricing>;
  /** False when the scope had no document. */
  deletePlatformPricing(scope: string): Promise<boolean>;
  /** Reloads the in-memory copy. */
  loadPlatformPricing(): Promise<void>;
  /** The prices for `tenantId` (the platform default without one), from the in-memory copy. */
  resolvePricing(tenantId?: string): ResolvedPricing;
  /** Credits one web search costs `tenantId`; 0 when no search price or currency is set. */
  webSearchCredits(tenantId?: string): number;
}

const currencySchema = new Schema<PricingCurrency>(
  {
    code: { type: String, required: true, match: /^[A-Z]{3}$/ },
    rate: { type: Number, required: true, min: 0.000001 },
  },
  { _id: false },
);

const platformPricingSchema = new Schema<PlatformPricing>(
  {
    scope: { type: String, required: true, unique: true },
    tokenMarkup: { type: Number, min: 0, max: 10 },
    searchPer1000: { type: Number, min: 0, max: 10_000 },
    currency: { type: currencySchema, default: undefined },
  },
  { timestamps: true },
);

const CREDITS_PER_USD = 1_000_000;

function toPricing(doc: PlatformPricing): PlatformPricing {
  return {
    scope: doc.scope,
    ...(doc.tokenMarkup != null && { tokenMarkup: doc.tokenMarkup }),
    ...(doc.searchPer1000 != null && { searchPer1000: doc.searchPer1000 }),
    ...(doc.currency && { currency: { code: doc.currency.code, rate: doc.currency.rate } }),
    ...(doc.updatedAt && { updatedAt: doc.updatedAt }),
  };
}

export function createPlatformPricingMethods(
  mongoose: typeof import('mongoose'),
  options: { refreshMs?: number; now?: () => number } = {},
): PlatformPricingMethods {
  const Pricing: Model<PlatformPricing> =
    mongoose.models.PlatformPricing ||
    mongoose.model<PlatformPricing>('PlatformPricing', platformPricingSchema);
  const refreshMs = options.refreshMs ?? 60_000;
  const now = options.now ?? Date.now;

  let byScope = new Map<string, PlatformPricing>();
  let loadedAt = -Infinity;
  let loading: Promise<void> | null = null;

  async function loadPlatformPricing(): Promise<void> {
    const docs = await Pricing.find({}).lean<PlatformPricing[]>();
    byScope = new Map(docs.map((doc) => [doc.scope, toPricing(doc)]));
    loadedAt = now();
  }

  /** Starts a reload when the copy is stale; the caller keeps using the current copy. */
  function refreshIfStale(): void {
    if (loading || now() - loadedAt < refreshMs) {
      return;
    }
    loading = loadPlatformPricing()
      .catch(() => {
        // Keep the last copy; the next stale read tries again.
        loadedAt = now();
      })
      .finally(() => {
        loading = null;
      });
  }

  function resolvePricing(tenantId?: string): ResolvedPricing {
    refreshIfStale();
    const base = byScope.get(DEFAULT_PRICING_SCOPE);
    const own =
      tenantId && tenantId !== SYSTEM_TENANT_ID && tenantId !== DEFAULT_PRICING_SCOPE
        ? byScope.get(tenantId)
        : undefined;
    return {
      tokenMarkup: own?.tokenMarkup ?? base?.tokenMarkup ?? 0,
      searchPer1000: own?.searchPer1000 ?? base?.searchPer1000 ?? 0,
      ...(base?.currency && { currency: base.currency }),
    };
  }

  return {
    async listPlatformPricing() {
      const docs = await Pricing.find({}).sort({ scope: 1 }).lean<PlatformPricing[]>();
      return docs.map(toPricing);
    },

    async setPlatformPricing(pricing) {
      const { scope, tokenMarkup, searchPer1000, currency } = pricing;
      const set = {
        scope,
        ...(tokenMarkup != null && { tokenMarkup }),
        ...(searchPer1000 != null && { searchPer1000 }),
        ...(currency && { currency }),
      };
      const unset = {
        ...(tokenMarkup == null && { tokenMarkup: 1 }),
        ...(searchPer1000 == null && { searchPer1000: 1 }),
        ...(currency == null && { currency: 1 }),
      };
      const doc = await Pricing.findOneAndUpdate(
        { scope },
        { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) },
        { upsert: true, new: true, runValidators: true },
      ).lean<PlatformPricing>();
      const saved = toPricing(doc as PlatformPricing);
      byScope.set(scope, saved);
      return saved;
    },

    async deletePlatformPricing(scope) {
      const { deletedCount } = await Pricing.deleteOne({ scope });
      byScope.delete(scope);
      return deletedCount > 0;
    },

    loadPlatformPricing,
    resolvePricing,

    webSearchCredits(tenantId) {
      const { searchPer1000, currency } = resolvePricing(tenantId);
      if (!searchPer1000 || !currency) {
        return 0;
      }
      return Math.round((searchPer1000 / 1000 / currency.rate) * CREDITS_PER_USD);
    },
  };
}

interface RateLookup {
  model?: string;
  valueKey?: string;
  tokenType?: 'prompt' | 'completion';
}

/**
 * Token rate lookups with the caller's tenant markup applied. Only priced lookups (a prompt or
 * completion rate of a model) are scaled; the neutral `1` returned without a token type or model
 * stays as it is, so credit transactions and refills keep their amounts.
 */
export function withTokenMarkup<
  M extends (args: RateLookup) => number,
  C extends (args: Omit<RateLookup, 'tokenType'>) => number | null,
>(
  rates: { getMultiplier: M; getCacheMultiplier: C },
  markup: () => number,
): { getMultiplier: M; getCacheMultiplier: C } {
  const factor = () => 1 + Math.max(0, markup() || 0);
  const getMultiplier = ((args: RateLookup) => {
    const rate = rates.getMultiplier(args);
    const priced =
      (args.tokenType === 'prompt' || args.tokenType === 'completion') &&
      Boolean(args.model || args.valueKey);
    return priced ? rate * factor() : rate;
  }) as M;
  const getCacheMultiplier = ((args: Omit<RateLookup, 'tokenType'>) => {
    const rate = rates.getCacheMultiplier(args);
    return rate == null ? rate : rate * factor();
  }) as C;
  return { getMultiplier, getCacheMultiplier };
}
