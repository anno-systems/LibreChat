import { logger, DEFAULT_MAX_PAGES_PER_SEARCH } from '@librechat/data-schemas';
import type { AppConfig, PricingCurrency } from '@librechat/data-schemas';
import type { TModelsConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { TokenomicsDeps } from '~/endpoints/pricing';
import type { ServerRequest } from '~/types/http';
import { resolveTokenConfigMap } from '~/endpoints/tokenConfig';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Model rates for the admin dashboard (fork-only): `GET /api/admin/usage/pricing`.
 *
 * Rates are LibreChat's credit multipliers, i.e. USD per 1M tokens (1,000,000 credits = 1 USD),
 * for every model the caller's tenant offers. They are returned whether or not the tenant shows
 * costs in chat (`interface.contextCost`), and carry the operator's markup for the tenant, as
 * charged. With platform pricing, the answer adds the display currency, the price of 1,000 web
 * searches (`search.per1000`) and of 1,000 pages they fetch (`fetch.per1000`), both in that
 * currency and only when set; `fetch` also carries the operator's cap on the pages one search
 * fetches for the tenant (`fetch.maxPagesPerSearch`, 5 when unset; a search with news may fetch
 * twice as many).
 */

export interface AdminModelRate {
  endpoint: string;
  model: string;
  /** USD per 1M input tokens; `null` when an endpoint's `tokenConfig` sets only the other rate. */
  prompt: number | null;
  /** USD per 1M output tokens; `null` when an endpoint's `tokenConfig` sets only the other rate. */
  completion: number | null;
}

export interface AdminPricingDeps extends TokenomicsDeps {
  /** The tenant-wide config (no role, group or user overrides). */
  getTenantAppConfig: (tenantId: string) => Promise<AppConfig>;
  /** Endpoint → models, resolved from `req.config` the way `/api/models` does. */
  getModelsConfig: (req: ServerRequest) => Promise<TModelsConfig>;
  /** The operator's prices for the tenant (`platformPricing`). */
  resolvePricing?: (tenantId?: string) => {
    searchPer1000: number;
    fetchPer1000?: number;
    maxPagesPerSearch?: number;
    currency?: PricingCurrency;
  };
}

export function createAdminPricingHandler(
  deps: AdminPricingDeps,
): (req: ServerRequest, res: Response) => Promise<Response> {
  const { getTenantAppConfig, getModelsConfig, resolvePricing, ...tokenomics } = deps;
  return async (req, res) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId || !req.user) {
      return res.status(400).json({ error: 'tenant_required' });
    }
    try {
      const appConfig = await getTenantAppConfig(tenantId);
      req.config = appConfig;
      const modelsConfig = await getModelsConfig(req);
      const map = await resolveTokenConfigMap(
        {
          appConfig: {
            ...appConfig,
            interfaceConfig: { ...appConfig.interfaceConfig, contextCost: true },
          },
          modelsConfig,
          userId: req.user.id,
          tenantId,
        },
        tokenomics,
      );
      const models: AdminModelRate[] = [];
      for (const endpoint of Object.keys(map).sort()) {
        for (const model of Object.keys(map[endpoint]).sort()) {
          const { prompt, completion } = map[endpoint][model];
          models.push({ endpoint, model, prompt: prompt ?? null, completion: completion ?? null });
        }
      }
      const pricing = resolvePricing?.(tenantId);
      return res.json({
        models,
        ...(pricing?.currency && { currency: pricing.currency }),
        ...(pricing?.searchPer1000 && { search: { per1000: pricing.searchPer1000 } }),
        ...(pricing?.fetchPer1000 && {
          fetch: {
            per1000: pricing.fetchPer1000,
            maxPagesPerSearch: pricing.maxPagesPerSearch ?? DEFAULT_MAX_PAGES_PER_SEARCH,
          },
        }),
      });
    } catch (error) {
      logger.error('[adminPricing] Failed to load model rates', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to load model rates' });
    }
  };
}
