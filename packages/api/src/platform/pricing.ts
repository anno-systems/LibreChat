import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import type { PlatformPricing } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The operator's prices (fork-only), on the operator API (`PLATFORM_API_TOKEN`): a markup on
 * every model's token rates and a price per 1,000 web searches, as a platform default and per
 * tenant, and the currency prices are shown in. Unset, nothing is added to upstream's rates and
 * searches cost nothing.
 *
 *   GET    /api/platform/pricing                     default and every tenant override
 *   PUT    /api/platform/pricing                     the default, with the currency
 *   PUT    /api/platform/tenants/:tenantId/pricing   a tenant's override
 *   DELETE /api/platform/tenants/:tenantId/pricing   back to the default
 */

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const DEFAULT_SCOPE = 'default';

const amounts = {
  /** Fraction added to token rates: 0.15 charges 115 %. */
  tokenMarkup: z.number().min(0).max(10).optional(),
  /** Price of 1,000 web searches in the display currency. */
  searchPer1000: z.number().min(0).max(10_000).optional(),
};

const defaultSchema = z
  .object({
    ...amounts,
    currency: z
      .object({
        code: z.string().regex(/^[A-Z]{3}$/),
        /** Units of the currency per USD. */
        rate: z.number().positive().max(1_000_000),
      })
      .strict()
      .optional(),
  })
  .strict();

const tenantSchema = z.object(amounts).strict();

export interface PlatformPricingStore {
  listPlatformPricing(): Promise<PlatformPricing[]>;
  setPlatformPricing(pricing: PlatformPricing): Promise<PlatformPricing>;
  deletePlatformPricing(scope: string): Promise<boolean>;
}

export interface PlatformPricingHandlers {
  getPricing(req: Request, res: Response): Promise<Response>;
  putDefaultPricing(req: Request, res: Response): Promise<Response>;
  putTenantPricing(req: Request, res: Response): Promise<Response>;
  deleteTenantPricing(req: Request, res: Response): Promise<Response>;
}

function present({ scope: _scope, ...pricing }: PlatformPricing) {
  return pricing;
}

export function createPlatformPricingHandlers(
  store: PlatformPricingStore,
): PlatformPricingHandlers {
  const fail = (res: Response, label: string, error: unknown) => {
    logger.error(`[platformPricing] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'internal_error' });
  };

  const tenantOf = (req: Request): string | undefined => {
    const { tenantId } = req.params;
    return typeof tenantId === 'string' && TENANT_ID.test(tenantId) && tenantId !== DEFAULT_SCOPE
      ? tenantId
      : undefined;
  };

  return {
    async getPricing(_req, res) {
      try {
        const all = await store.listPlatformPricing();
        const base = all.find((pricing) => pricing.scope === DEFAULT_SCOPE);
        return res.json({
          default: base ? present(base) : {},
          tenants: all
            .filter((pricing) => pricing.scope !== DEFAULT_SCOPE)
            .map((pricing) => ({ tenantId: pricing.scope, ...present(pricing) })),
        });
      } catch (error) {
        return fail(res, 'list', error);
      }
    },

    async putDefaultPricing(req, res) {
      try {
        const parsed = defaultSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: 'invalid_pricing' });
        }
        const saved = await store.setPlatformPricing({ scope: DEFAULT_SCOPE, ...parsed.data });
        logger.info('[platformPricing] default saved', {
          tokenMarkup: saved.tokenMarkup ?? 0,
          searchPer1000: saved.searchPer1000 ?? 0,
          currency: saved.currency?.code,
        });
        return res.json({ pricing: present(saved) });
      } catch (error) {
        return fail(res, 'put default', error);
      }
    },

    async putTenantPricing(req, res) {
      try {
        const tenantId = tenantOf(req);
        if (!tenantId) {
          return res.status(400).json({ error: 'invalid_tenant_id' });
        }
        const parsed = tenantSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: 'invalid_pricing' });
        }
        const saved = await store.setPlatformPricing({ scope: tenantId, ...parsed.data });
        logger.info('[platformPricing] tenant override saved', { tenantId });
        return res.json({ pricing: { tenantId, ...present(saved) } });
      } catch (error) {
        return fail(res, 'put tenant', error);
      }
    },

    async deleteTenantPricing(req, res) {
      try {
        const tenantId = tenantOf(req);
        if (!tenantId) {
          return res.status(400).json({ error: 'invalid_tenant_id' });
        }
        if (!(await store.deletePlatformPricing(tenantId))) {
          return res.status(404).json({ error: 'not_found' });
        }
        logger.info('[platformPricing] tenant override removed', { tenantId });
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'delete tenant', error);
      }
    },
  };
}

/**
 * The signed-in startup config's interface with the operator's display currency, so balances and
 * the costs shown in chat use it; without platform pricing the interface stays as configured.
 */
export function withPricingCurrency<T extends { currency?: { code: string; rate: number } }>(
  interfaceConfig: T | undefined,
  currency: { code: string; rate: number } | undefined,
): T | undefined {
  if (!currency || !interfaceConfig) {
    return interfaceConfig;
  }
  return { ...interfaceConfig, currency };
}
