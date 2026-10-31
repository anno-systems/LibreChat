import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import { bannerKindSchema, toBannerKind } from 'librechat-data-provider';
import type { PlatformBanner } from '@librechat/data-schemas';
import type { BannerKind } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Platform banners (fork-only): the operator API (`PLATFORM_API_TOKEN`) keeps banners for every
 * tenant or for chosen ones, and the chat's banner route shows the one that applies next to the
 * tenant's own upstream banner.
 */

const BANNER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const bannerInputSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    displayFrom: z.string().datetime({ offset: true }),
    displayTo: z.string().datetime({ offset: true }).optional(),
    isPublic: z.boolean().optional(),
    persistable: z.boolean().optional(),
    /** Omitted: `info`, shown like an upstream banner. */
    kind: bannerKindSchema.optional(),
    /** Omitted: every tenant. */
    tenantIds: z
      .array(z.string().regex(TENANT_ID))
      .min(1)
      .max(500)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .strict()
  .refine((b) => !b.displayTo || Date.parse(b.displayTo) > Date.parse(b.displayFrom), {
    message: 'displayTo must be after displayFrom',
    path: ['displayTo'],
  });

export interface PlatformBannerStore {
  listPlatformBanners(): Promise<PlatformBanner[]>;
  upsertPlatformBanner(banner: PlatformBanner): Promise<PlatformBanner>;
  deletePlatformBanner(bannerId: string): Promise<boolean>;
}

export interface PlatformBannerHandlers {
  listBanners(req: Request, res: Response): Promise<Response>;
  putBanner(req: Request, res: Response): Promise<Response>;
  deleteBanner(req: Request, res: Response): Promise<Response>;
}

export function createPlatformBannerHandlers(store: PlatformBannerStore): PlatformBannerHandlers {
  const fail = (res: Response, label: string, error: unknown) => {
    logger.error(`[platformBanners] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'internal_error' });
  };

  return {
    /** GET /api/platform/banners */
    async listBanners(_req, res) {
      try {
        return res.json({ banners: await store.listPlatformBanners() });
      } catch (error) {
        return fail(res, 'list', error);
      }
    },

    /** PUT /api/platform/banners/:id */
    async putBanner(req, res) {
      try {
        const bannerId = req.params.id;
        if (typeof bannerId !== 'string' || !BANNER_ID.test(bannerId)) {
          return res.status(400).json({ error: 'invalid_banner_id' });
        }
        const parsed = bannerInputSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: 'invalid_banner' });
        }
        const { displayFrom, displayTo, isPublic, persistable, kind, ...rest } = parsed.data;
        const banner = await store.upsertPlatformBanner({
          ...rest,
          bannerId,
          displayFrom: new Date(displayFrom),
          ...(displayTo && { displayTo: new Date(displayTo) }),
          isPublic: isPublic === true,
          persistable: persistable === true,
          kind: kind ?? 'info',
        });
        logger.info('[platformBanners] banner saved', {
          bannerId,
          kind: banner.kind,
          tenants: banner.tenantIds?.length ?? 'all',
        });
        return res.json({ banner });
      } catch (error) {
        return fail(res, 'put', error);
      }
    },

    /** DELETE /api/platform/banners/:id */
    async deleteBanner(req, res) {
      try {
        const bannerId = req.params.id;
        if (typeof bannerId !== 'string' || !BANNER_ID.test(bannerId)) {
          return res.status(400).json({ error: 'invalid_banner_id' });
        }
        if (!(await store.deletePlatformBanner(bannerId))) {
          return res.status(404).json({ error: 'not_found' });
        }
        logger.info('[platformBanners] banner deleted', { bannerId });
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'delete', error);
      }
    },
  };
}

/** A banner as the chat's banner route answers it (upstream's shape). */
export interface ShownBanner {
  bannerId: string;
  message: string;
  displayFrom: Date;
  displayTo?: Date;
  type: 'banner';
  isPublic: boolean;
  persistable: boolean;
  /** Platform banners only; a tenant's own banner has none. */
  kind?: BannerKind;
}

export interface BannerResolverDeps<T extends ShownBanner> {
  /** Upstream's banner of the request's tenant, already filtered for signed-out callers. */
  getBanner(user?: unknown): Promise<T | null>;
  findActivePlatformBanner(tenantId: string | undefined): Promise<PlatformBanner | null>;
  /**
   * Whether the tenant's own banner may be looked up for a request without a tenant (a
   * single-tenant deployment). Off under strict tenant isolation, where such a lookup is refused:
   * the request gets only a platform banner for every tenant. Default true, as upstream.
   */
  ownWithoutTenant?: boolean;
}

/**
 * The banner to show: the tenant's own or the operator's for this tenant, whichever started
 * later. A platform banner that is not public is shown to signed-in users only, as upstream's.
 */
export function createBannerResolver<T extends ShownBanner>(deps: BannerResolverDeps<T>) {
  return async function currentBanner(
    user: unknown,
    tenantId: string | undefined,
  ): Promise<T | ShownBanner | null> {
    const ownAllowed = tenantId !== undefined || deps.ownWithoutTenant !== false;
    const [own, platform] = await Promise.all([
      ownAllowed ? deps.getBanner(user) : null,
      deps.findActivePlatformBanner(tenantId),
    ]);
    const shown =
      platform && (platform.isPublic || user != null)
        ? {
            bannerId: platform.bannerId,
            message: platform.message,
            displayFrom: platform.displayFrom,
            ...(platform.displayTo && { displayTo: platform.displayTo }),
            type: 'banner' as const,
            isPublic: platform.isPublic,
            persistable: platform.persistable,
            kind: toBannerKind(platform.kind),
          }
        : null;
    if (!own) return shown;
    if (!shown) return own;
    return new Date(shown.displayFrom) > new Date(own.displayFrom) ? shown : own;
  };
}
