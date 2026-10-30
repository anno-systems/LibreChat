import { z } from 'zod';
import { logger, PLATFORM_REDIRECT_SCOPE } from '@librechat/data-schemas';
import type { AppConfig, ModelMigrationMethods, ModelRef } from '@librechat/data-schemas';
import type { TModelsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { MigrationAuditEvent, MigrationScope, ModelMigrationService } from './service';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';
import { redirectView } from './service';

/**
 * HTTP handlers of model migrations (fork-only).
 *
 * - Operator (`/api/platform`, `PLATFORM_API_TOKEN`): migrations for every tenant or listed
 *   tenants; the target must be a model of the catalog.
 * - Tenant admin (`/api/admin/models`): migrations within the caller's tenant; the target must be
 *   a model enabled for the tenant.
 *
 * Both have a preview (counts per kind) and a usage count; neither returns documents.
 */

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const REDIRECT_ID = /^mm_[0-9a-f-]{36}$/;
const MAX_USAGE_MODELS = 50;

export const modelRefSchema: z.ZodType<ModelRef> = z
  .object({
    endpoint: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    /** Display name for notices ("Mistral Large 3"); the configuration's or the id without one. */
    label: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const tenantIdsSchema = z
  .array(
    z
      .string()
      .regex(TENANT_ID)
      .refine((id) => id !== '__SYSTEM__'),
  )
  .min(1)
  .max(500)
  .transform((ids) => [...new Set(ids)]);

const operatorMigrationSchema = z
  .object({ from: modelRefSchema, to: modelRefSchema, tenantIds: tenantIdsSchema.optional() })
  .strict();
const operatorPreviewSchema = z
  .object({ from: modelRefSchema, tenantIds: tenantIdsSchema.optional() })
  .strict();
const operatorUsageSchema = z
  .object({
    models: z.array(modelRefSchema).min(1).max(MAX_USAGE_MODELS),
    tenantIds: tenantIdsSchema.optional(),
  })
  .strict();

const adminMigrationSchema = z.object({ from: modelRefSchema, to: modelRefSchema }).strict();
const adminPreviewSchema = z.object({ from: modelRefSchema }).strict();
const adminUsageSchema = z
  .object({ models: z.array(modelRefSchema).min(1).max(MAX_USAGE_MODELS) })
  .strict();

type Store = Pick<ModelMigrationMethods, 'listModelRedirects' | 'deleteModelRedirect'>;

function fail(res: Response, label: string, error: unknown): Response {
  logger.error(`[modelMigration] ${label} failed`, getSafeErrorMetadata(error));
  return res.status(500).json({ error: 'Internal server error' });
}

const MIGRATION_ERRORS = { same_model: 400, redirect_cycle: 409 } as const;

type Handler<R> = (req: R, res: Response) => Promise<Response>;

export interface OperatorMigrationHandlerDeps {
  service: ModelMigrationService;
  store: Store;
  /** Whether `ref` is a model of the platform catalog (a platform provider or librechat.yaml). */
  isCatalogModel(ref: ModelRef): Promise<boolean>;
  /** Records an operator event, as the operator the admin app names. */
  audit(req: Request, event: MigrationAuditEvent): Promise<void>;
  /** The operator the admin app names, recorded on the redirect. */
  operatorId(req: Request): string;
}

export interface OperatorMigrationHandlers {
  listRedirects: Handler<Request>;
  deleteRedirect: Handler<Request>;
  preview: Handler<Request>;
  migrate: Handler<Request>;
  usage: Handler<Request>;
}

export function createOperatorMigrationHandlers(
  deps: OperatorMigrationHandlerDeps,
): OperatorMigrationHandlers {
  const { service, store } = deps;
  const scopeOf = (tenantIds?: string[]): MigrationScope => ({
    platform: true,
    ...(tenantIds && { tenantIds }),
  });

  return {
    /** GET /api/platform/model-redirects[?tenantId=]: the operator's, or one tenant's own too. */
    async listRedirects(req, res) {
      try {
        const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
        if (tenantId !== undefined && !TENANT_ID.test(tenantId)) {
          return res.status(400).json({ error: 'invalid_tenant' });
        }
        const [platform, own] = await Promise.all([
          store.listModelRedirects({ scope: PLATFORM_REDIRECT_SCOPE }),
          tenantId ? store.listModelRedirects({ scope: tenantId }) : Promise.resolve([]),
        ]);
        const applying = tenantId
          ? platform.filter((r) => !r.tenantIds || r.tenantIds.includes(tenantId))
          : platform;
        return res.json({ redirects: [...applying, ...own].map(redirectView) });
      } catch (error) {
        return fail(res, 'redirect list', error);
      }
    },

    /** DELETE /api/platform/model-redirects/:id (the operator's only) */
    async deleteRedirect(req, res) {
      try {
        const id = String((req.params as { id?: string }).id ?? '');
        if (!REDIRECT_ID.test(id)) return res.status(404).json({ error: 'not_found' });
        const [redirect] = (
          await store.listModelRedirects({ scope: PLATFORM_REDIRECT_SCOPE })
        ).filter((r) => r.redirectId === id);
        if (!redirect || !(await store.deleteModelRedirect(PLATFORM_REDIRECT_SCOPE, id))) {
          return res.status(404).json({ error: 'not_found' });
        }
        await deps.audit(req, {
          action: 'model.redirect_deleted',
          outcome: 'success',
          severity: 'info',
          tenantId: undefined,
          target: { type: 'model', id: `${redirect.from.endpoint}/${redirect.from.model}` },
          metadata: { migrationId: id, to: `${redirect.to.endpoint}/${redirect.to.model}` },
        });
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'redirect delete', error);
      }
    },

    /** POST /api/platform/model-migrations/preview */
    async preview(req, res) {
      try {
        const parsed = operatorPreviewSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_migration' });
        const counts = await service.preview(scopeOf(parsed.data.tenantIds), parsed.data.from);
        return res.json({ counts });
      } catch (error) {
        return fail(res, 'migration preview', error);
      }
    },

    /** POST /api/platform/model-migrations */
    async migrate(req, res) {
      try {
        const parsed = operatorMigrationSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_migration' });
        const { from, to, tenantIds } = parsed.data;
        if (!(await deps.isCatalogModel(to))) {
          return res.status(400).json({ error: 'unknown_target' });
        }
        const outcome = await service.run({
          scope: scopeOf(tenantIds),
          from,
          to,
          createdBy: deps.operatorId(req),
          audit: (event) => deps.audit(req, event),
        });
        if (!outcome.ok) {
          return res
            .status(MIGRATION_ERRORS[outcome.error.code])
            .json({ error: outcome.error.code });
        }
        return res.json({ migration: outcome.migration });
      } catch (error) {
        return fail(res, 'migration', error);
      }
    },

    /** POST /api/platform/model-usage */
    async usage(req, res) {
      try {
        const parsed = operatorUsageSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_models' });
        const scope = scopeOf(parsed.data.tenantIds);
        const usage = await service.usage(scope, parsed.data.models);
        return res.json({ models: usage.map((u) => withRedirect(service, scope, u)) });
      } catch (error) {
        return fail(res, 'usage count', error);
      }
    },
  };
}

export interface AdminMigrationHandlerDeps {
  service: ModelMigrationService;
  store: Store;
  /** The tenant-wide config (no role, group or user overrides). */
  getTenantAppConfig(tenantId: string): Promise<AppConfig>;
  /** Endpoint → models, resolved from `req.config` the way `/api/models` does. */
  getModelsConfig(req: ServerRequest): Promise<TModelsConfig>;
  /** Records an event in the caller's tenant, as the caller. */
  audit(req: ServerRequest, event: MigrationAuditEvent): Promise<void>;
}

export interface AdminMigrationHandlers {
  listRedirects: Handler<ServerRequest>;
  deleteRedirect: Handler<ServerRequest>;
  preview: Handler<ServerRequest>;
  migrate: Handler<ServerRequest>;
  usage: Handler<ServerRequest>;
}

export function createAdminMigrationHandlers(
  deps: AdminMigrationHandlerDeps,
): AdminMigrationHandlers {
  const { service, store } = deps;

  function tenantOf(req: ServerRequest, res: Response): string | null {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'tenant_required' });
      return null;
    }
    return tenantId;
  }

  /** Whether the tenant-wide config offers `ref`. */
  async function isEnabled(req: ServerRequest, tenantId: string, ref: ModelRef): Promise<boolean> {
    const config = await deps.getTenantAppConfig(tenantId);
    const models = await deps.getModelsConfig({ ...req, config } as ServerRequest);
    return (models?.[ref.endpoint] ?? []).includes(ref.model);
  }

  return {
    /**
     * GET /api/admin/models/redirects: the tenant's own (`scope: 'tenant'`) and the operator's
     * that apply to it (`scope: 'platform'`, read-only).
     */
    async listRedirects(req, res) {
      try {
        const tenantId = tenantOf(req, res);
        if (!tenantId) return res;
        const [platform, own] = await Promise.all([
          store.listModelRedirects({ scope: PLATFORM_REDIRECT_SCOPE }),
          store.listModelRedirects({ scope: tenantId }),
        ]);
        const applying = platform
          .filter((r) => !r.tenantIds || r.tenantIds.includes(tenantId))
          .map(({ tenantIds: _hidden, ...r }) => r);
        return res.json({ redirects: [...own, ...applying].map(redirectView) });
      } catch (error) {
        return fail(res, 'redirect list', error);
      }
    },

    /** DELETE /api/admin/models/redirects/:id (the tenant's own only) */
    async deleteRedirect(req, res) {
      try {
        const tenantId = tenantOf(req, res);
        if (!tenantId) return res;
        const id = String((req.params as { id?: string }).id ?? '');
        if (!REDIRECT_ID.test(id)) return res.status(404).json({ error: 'not_found' });
        const redirect = (await store.listModelRedirects({ scope: tenantId })).find(
          (r) => r.redirectId === id,
        );
        if (!redirect || !(await store.deleteModelRedirect(tenantId, id))) {
          return res.status(404).json({ error: 'not_found' });
        }
        await deps.audit(req, {
          action: 'model.redirect_deleted',
          outcome: 'success',
          severity: 'info',
          target: { type: 'model', id: `${redirect.from.endpoint}/${redirect.from.model}` },
          metadata: { migrationId: id, to: `${redirect.to.endpoint}/${redirect.to.model}` },
        });
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'redirect delete', error);
      }
    },

    /** POST /api/admin/models/migrations/preview */
    async preview(req, res) {
      try {
        const tenantId = tenantOf(req, res);
        if (!tenantId) return res;
        const parsed = adminPreviewSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_migration' });
        return res.json({ counts: await service.preview({ tenantId }, parsed.data.from) });
      } catch (error) {
        return fail(res, 'migration preview', error);
      }
    },

    /** POST /api/admin/models/migrations */
    async migrate(req, res) {
      try {
        const tenantId = tenantOf(req, res);
        if (!tenantId) return res;
        const parsed = adminMigrationSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_migration' });
        const { from, to } = parsed.data;
        if (!(await isEnabled(req, tenantId, to))) {
          return res.status(400).json({ error: 'target_not_enabled' });
        }
        const outcome = await service.run({
          scope: { tenantId },
          from,
          to,
          createdBy: req.user?.id,
          audit: (event) => deps.audit(req, event),
        });
        if (!outcome.ok) {
          return res
            .status(MIGRATION_ERRORS[outcome.error.code])
            .json({ error: outcome.error.code });
        }
        return res.json({ migration: outcome.migration });
      } catch (error) {
        return fail(res, 'migration', error);
      }
    },

    /**
     * POST /api/admin/models/usage: agents and conversations per model, for the admin app to ask
     * for a successor before switching a model off. `redirected` is true when a redirect already
     * covers the model for the tenant.
     */
    async usage(req, res) {
      try {
        const tenantId = tenantOf(req, res);
        if (!tenantId) return res;
        const parsed = adminUsageSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_models' });
        const usage = await service.usage({ tenantId }, parsed.data.models);
        return res.json({ models: usage.map((u) => withRedirect(service, { tenantId }, u)) });
      } catch (error) {
        return fail(res, 'usage count', error);
      }
    },
  };
}

function withRedirect<T extends ModelRef>(
  service: ModelMigrationService,
  scope: MigrationScope,
  usage: T,
): T & { redirected: boolean } {
  return { ...usage, redirected: service.hasRedirect(scope, usage) };
}
