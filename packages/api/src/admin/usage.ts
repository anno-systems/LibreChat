import { logger } from '@librechat/data-schemas';
import type { TenantUsage, TenantUsageDays } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The tenant's chat usage for the admin dashboard (fork-only): `GET /api/admin/usage?days=`.
 * Aggregates only, never per person; always the caller's own tenant.
 */

const DAYS: readonly TenantUsageDays[] = [7, 30, 90];

export interface AdminUsageDeps {
  getTenantUsage: (options: {
    tenantId: string;
    days: TenantUsageDays;
    timeZone?: string;
  }) => Promise<TenantUsage>;
}

export function createAdminUsageHandler(
  deps: AdminUsageDeps,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    const query = req.query as { days?: unknown; timeZone?: unknown };
    const days = query.days === undefined ? 30 : Number(query.days);
    if (!DAYS.includes(days as TenantUsageDays)) {
      return res.status(400).json({ error: 'invalid_days' });
    }
    const timeZone =
      typeof query.timeZone === 'string' && query.timeZone.length <= 64
        ? query.timeZone
        : undefined;
    try {
      const usage = await deps.getTenantUsage({
        tenantId,
        days: days as TenantUsageDays,
        timeZone,
      });
      return res.json(usage);
    } catch (error) {
      logger.error('[adminUsage] Failed to load usage', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to load usage' });
    }
  };
}
