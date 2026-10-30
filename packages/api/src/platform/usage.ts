import { logger } from '@librechat/data-schemas';
import type { PlatformUsage, PlatformUsageDays } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * How the whole platform is used (fork-only), for the operator's overview:
 * `GET /api/platform/usage?days=7|30|90&timeZone=` (`PLATFORM_API_TOKEN`). Totals and per-day sums
 * across every tenant only, never a row per tenant or per person.
 *
 * And the record behind its sign-ins: each chat sign-in through the identity provider is noted
 * with its tenant and time, only while the operator API is configured (nothing reads it otherwise).
 */

const DAYS: readonly PlatformUsageDays[] = [7, 30, 90];
const TIME_ZONE = /^[A-Za-z_+\-/0-9]{1,64}$/;

export interface PlatformUsageDeps {
  getPlatformUsage(options: { days: PlatformUsageDays; timeZone?: string }): Promise<PlatformUsage>;
}

export function createPlatformUsageHandler(
  deps: PlatformUsageDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async (req, res) => {
    const query = req.query as { days?: unknown; timeZone?: unknown };
    const days = query.days === undefined ? 30 : Number(query.days);
    if (!DAYS.includes(days as PlatformUsageDays)) {
      return res.status(400).json({ error: 'invalid_days' });
    }
    const timeZone =
      typeof query.timeZone === 'string' && TIME_ZONE.test(query.timeZone)
        ? query.timeZone
        : undefined;
    try {
      const usage = await deps.getPlatformUsage({ days: days as PlatformUsageDays, timeZone });
      return res.json(usage);
    } catch (error) {
      logger.error('[platformUsage] Failed to load usage', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}

export interface SignInRecorderDeps {
  /** Whether sign-ins are recorded: the operator API that reads them is configured. */
  enabled: boolean;
  recordPlatformSignIn(entry: { tenantId?: string }): Promise<void>;
}

/**
 * Notes a chat sign-in without delaying it: the write runs in the background and a failure is
 * logged, never thrown, since the user is signed in either way.
 */
export function createSignInRecorder(
  deps: SignInRecorderDeps,
): (user?: { tenantId?: string } | null) => void {
  return (user) => {
    if (!deps.enabled || !user) return;
    const tenantId = typeof user.tenantId === 'string' ? user.tenantId : undefined;
    deps.recordPlatformSignIn({ tenantId }).catch((error: unknown) => {
      logger.warn('[platformUsage] Failed to record a sign-in', getSafeErrorMetadata(error));
    });
  };
}
