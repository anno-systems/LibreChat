import { logger, isCostMonth, SystemCapabilities } from '@librechat/data-schemas';
import type { TenantCosts, TenantCostPeriod, PricingCurrency } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * What the caller's tenant spent (fork-only): `GET /api/admin/usage/costs?days=7|30|90` or
 * `?month=YYYY-MM`, for the admin app's cost view. Amounts are credits (1,000,000 = 1 USD) as
 * charged, with the operator's markup; `currency` converts them for display. The per-user and
 * per-group lists are included only for callers who may read users (`READ_USERS`), since they
 * name people; the operator's markup itself is never part of the answer.
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
      const byPerson = await deps.hasCapability(
        req.user as CapabilityUser,
        SystemCapabilities.READ_USERS,
      );
      const costs = await deps.getTenantCosts({ tenantId, period, timeZone, byPerson });
      const { currency } = deps.resolvePricing(tenantId);
      return res.json({ ...costs, ...(currency && { currency }) });
    } catch (error) {
      logger.error('[adminCosts] Failed to load costs', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to load costs' });
    }
  };
}
