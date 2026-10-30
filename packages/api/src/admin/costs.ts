import {
  logger,
  isCostMonth,
  mcpChargesBetween,
  SystemCapabilities,
} from '@librechat/data-schemas';
import type {
  TenantCosts,
  McpSubscription,
  PricingCurrency,
  TenantCostPeriod,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * What the caller's tenant spent (fork-only): `GET /api/admin/usage/costs?days=7|30|90` or
 * `?month=YYYY-MM`, for the admin app's cost view. Amounts are credits (1,000,000 = 1 USD) as
 * charged, with the operator's markup; `currency` converts them for display. Web searches and the
 * pages they fetched are reported apart (`searchCredits`/`searches`, `fetchCredits`/`fetches`) in
 * the totals, per day, per user and per group. The per-user and
 * per-group lists are included only for callers who may read users (`READ_USERS`), since they
 * name people; the operator's markup itself is never part of the answer.
 *
 * With MCP server prices, `mcpServers` lists the fixed monthly charges of the period apart from
 * the credits: per subscription the price agreed to, its currency and the months charged (each
 * calendar month, in UTC, the server was on at any time and that overlaps the period).
 */

const DAYS = [7, 30, 90] as const;

export interface AdminCostsDeps {
  getTenantCosts: (options: {
    tenantId: string;
    period: TenantCostPeriod;
    timeZone?: string;
    byPerson?: boolean;
  }) => Promise<TenantCosts>;
  resolvePricing: (tenantId?: string) => { currency?: PricingCurrency };
  hasCapability: (user: CapabilityUser, capability: string) => Promise<boolean>;
  /** Fork (MCP pricing): the tenant's subscriptions to priced MCP servers. */
  listMcpSubscriptions?: (tenantId: string) => Promise<McpSubscription[]>;
  /** The platform's MCP servers with their titles, to label the charges. */
  listMcpServers?: () => Promise<{ name: string; title?: string }[]>;
  now?: () => Date;
}

/** One server's fixed charges in the period, as the cost view lists them. */
export interface McpServerCharge {
  server: string;
  label?: string;
  /** Monthly price agreed to, in `currency`. */
  price: number;
  currency: string;
  months: string[];
  /** `price` times the months, in `currency`. */
  amount: number;
}

function periodOf(query: { days?: unknown; month?: unknown }): TenantCostPeriod | null {
  if (query.month !== undefined) {
    return typeof query.month === 'string' && isCostMonth(query.month)
      ? { month: query.month }
      : null;
  }
  const days = query.days === undefined ? 30 : Number(query.days);
  return DAYS.includes(days as (typeof DAYS)[number])
    ? { days: days as (typeof DAYS)[number] }
    : null;
}

export function createAdminCostsHandler(
  deps: AdminCostsDeps,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId || !req.user) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const query = req.query as { days?: unknown; month?: unknown; timeZone?: unknown };
    const period = periodOf(query);
    if (!period) {
      return res.status(400).json({ error: 'invalid_period' });
    }
    const timeZone =
      typeof query.timeZone === 'string' && query.timeZone.length <= 64
        ? query.timeZone
        : undefined;
    try {
      const user = req.user as CapabilityUser;
      const [costs, subscriptions, servers] = await Promise.all([
        deps
          .hasCapability(user, SystemCapabilities.READ_USERS)
          .then((byPerson) => deps.getTenantCosts({ tenantId, period, timeZone, byPerson })),
        deps.listMcpSubscriptions?.(tenantId),
        deps.listMcpSubscriptions ? deps.listMcpServers?.() : undefined,
      ]);
      const { currency } = deps.resolvePricing(tenantId);
      const titles = new Map((servers ?? []).map((s) => [s.name, s.title]));
      const mcpServers: McpServerCharge[] | undefined =
        subscriptions &&
        mcpChargesBetween(subscriptions, costs.from, costs.to, deps.now?.() ?? new Date()).map(
          (charge) => ({
            ...charge,
            ...(titles.get(charge.server) && { label: titles.get(charge.server) }),
            amount: Math.round(charge.price * charge.months.length * 100) / 100,
          }),
        );
      return res.json({
        ...costs,
        ...(currency && { currency }),
        ...(mcpServers && { mcpServers }),
      });
    } catch (error) {
      logger.error('[adminCosts] Failed to load costs', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to load costs' });
    }
  };
}
