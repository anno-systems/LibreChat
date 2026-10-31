import type { PipelineStage } from 'mongoose';
import type { McpCharge, McpSubscription } from './mcpPricing';
import { WEB_FETCH_CONTEXT, WEB_SEARCH_CONTEXT } from './tenantCosts';
import { runAsSystem } from '~/config/tenantContext';

/**
 * The operator's monthly statement of every tenant (fork-only): what each tenant was charged for
 * tokens, web searches and fetched pages, what the tokens cost at the providers' rates (the
 * charge without the operator's markup), and the MCP servers it subscribed to that month. Credits
 * are USD-based (1,000,000 credits = 1 USD); MCP prices are in the currency they were accepted
 * in. Months are calendar months in UTC, as MCP subscriptions are billed.
 *
 * Token transactions record the markup their rate carried (`withMarkupRecord`). Older ones do
 * not; their provider cost is estimated with the tenant's current markup and their charge is
 * reported in `estimatedTokenCredits`.
 */

export interface PlatformInvoiceTenant {
  tenantId: string;
  /** Credits charged for tokens, markup included. */
  tokenCredits: number;
  /** What those tokens cost at the providers' rates. */
  providerCredits: number;
  /** The part of `tokenCredits` whose markup was not recorded and is estimated. */
  estimatedTokenCredits: number;
  searchCredits: number;
  searches: number;
  fetchCredits: number;
  fetches: number;
  /** MCP servers charged for this month. */
  mcp: Array<{ server: string; price: number; currency: string }>;
}

export interface PlatformInvoices {
  /** `YYYY-MM`. */
  month: string;
  /** Start (inclusive) and end (exclusive) of the month, ISO. */
  from: string;
  to: string;
  tenants: PlatformInvoiceTenant[];
}

export interface PlatformInvoiceMethods {
  getPlatformInvoices(input: { month: string; now?: Date }): Promise<PlatformInvoices>;
}

export interface PlatformInvoiceDeps {
  /** The tenant's current token markup, for transactions that did not record one. */
  tokenMarkup(tenantId: string): number;
  listMcpSubscriptions(): Promise<McpSubscription[]>;
  listMcpCharges(input: {
    tenantId: string;
    from: string;
    to: string;
    now?: Date;
  }): Promise<McpCharge[]>;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

interface Row {
  _id: { tenantId: string; markup: number | null };
  tokenCredits: number;
  searchCredits: number;
  searches: number;
  fetchCredits: number;
  fetches: number;
}

const spent = { $multiply: [-1, { $ifNull: ['$tokenValue', 0] }] };
const isToken = { $in: ['$tokenType', ['prompt', 'completion']] };
const isSearch = { $eq: ['$context', WEB_SEARCH_CONTEXT] };
const isFetch = { $eq: ['$context', WEB_FETCH_CONTEXT] };

const empty = (tenantId: string): PlatformInvoiceTenant => ({
  tenantId,
  tokenCredits: 0,
  providerCredits: 0,
  estimatedTokenCredits: 0,
  searchCredits: 0,
  searches: 0,
  fetchCredits: 0,
  fetches: 0,
  mcp: [],
});

/** The first and last day (`YYYY-MM-DD`) and the UTC bounds of a month; null for another value. */
export function invoiceMonth(
  month: string,
): { start: Date; end: Date; firstDay: string; lastDay: string } | null {
  const match = MONTH.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]);
  const start = new Date(Date.UTC(year, index - 1, 1));
  const end = new Date(Date.UTC(year, index, 1));
  const lastDay = new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10);
  return { start, end, firstDay: `${month}-01`, lastDay };
}

export function createPlatformInvoiceMethods(
  mongoose: typeof import('mongoose'),
  deps: PlatformInvoiceDeps,
): PlatformInvoiceMethods {
  return {
    async getPlatformInvoices({ month, now = new Date() }) {
      const bounds = invoiceMonth(month);
      if (!bounds) throw new Error(`Not a month: ${month}`);
      const Transaction = mongoose.models.Transaction;
      const pipeline: PipelineStage[] = [
        {
          $match: {
            createdAt: { $gte: bounds.start, $lt: bounds.end },
            tenantId: { $type: 'string', $ne: '' },
          },
        },
        {
          $group: {
            _id: {
              tenantId: '$tenantId',
              markup: { $cond: [isToken, { $ifNull: ['$markup', null] }, null] },
            },
            tokenCredits: { $sum: { $cond: [isToken, spent, 0] } },
            searchCredits: { $sum: { $cond: [isSearch, spent, 0] } },
            searches: { $sum: { $cond: [isSearch, 1, 0] } },
            fetchCredits: { $sum: { $cond: [isFetch, spent, 0] } },
            fetches: { $sum: { $cond: [isFetch, 1, 0] } },
          },
        },
      ];
      const [rows, subscriptions] = await Promise.all([
        Transaction
          ? runAsSystem(() => Transaction.aggregate<Row>(pipeline))
          : Promise.resolve([] as Row[]),
        deps.listMcpSubscriptions(),
      ]);

      const byTenant = new Map<string, PlatformInvoiceTenant>();
      const of = (tenantId: string) => {
        let tenant = byTenant.get(tenantId);
        if (!tenant) {
          tenant = empty(tenantId);
          byTenant.set(tenantId, tenant);
        }
        return tenant;
      };

      for (const row of rows) {
        const tenant = of(row._id.tenantId);
        const recorded = row._id.markup;
        const markup = recorded ?? deps.tokenMarkup(row._id.tenantId);
        tenant.tokenCredits += row.tokenCredits;
        tenant.providerCredits += row.tokenCredits / (1 + Math.max(0, markup));
        if (recorded == null) tenant.estimatedTokenCredits += row.tokenCredits;
        tenant.searchCredits += row.searchCredits;
        tenant.searches += row.searches;
        tenant.fetchCredits += row.fetchCredits;
        tenant.fetches += row.fetches;
      }

      const subscribed = new Set(subscriptions.map((s) => s.tenantId));
      await Promise.all(
        [...subscribed].map(async (tenantId) => {
          const charges = await deps.listMcpCharges({
            tenantId,
            from: bounds.firstDay,
            to: bounds.lastDay,
            now,
          });
          const charged = charges.filter((c) => c.months.includes(month));
          if (charged.length === 0) return;
          of(tenantId).mcp = charged.map(({ server, price, currency }) => ({
            server,
            price,
            currency,
          }));
        }),
      );

      const tenants = [...byTenant.values()]
        .map((t) => ({
          ...t,
          tokenCredits: Math.round(t.tokenCredits),
          providerCredits: Math.round(t.providerCredits),
          estimatedTokenCredits: Math.round(t.estimatedTokenCredits),
          searchCredits: Math.round(t.searchCredits),
          fetchCredits: Math.round(t.fetchCredits),
          mcp: [...t.mcp].sort((a, b) => a.server.localeCompare(b.server)),
        }))
        .sort((a, b) => a.tenantId.localeCompare(b.tenantId));

      return {
        month,
        from: bounds.start.toISOString(),
        to: bounds.end.toISOString(),
        tenants,
      };
    },
  };
}
