import { z } from 'zod';
import crypto from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { providerLimitsSchema } from 'librechat-data-provider';
import type {
  AppConfig,
  AuditActorInput,
  CatalogAssignment,
  PlatformCatalogMethods,
  PlatformProvider,
  RecordAuditEntryInput,
} from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import { createAdminAuditEmitter, recordSystemAuditEntry } from '~/admin/audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { validateEndpointURL } from '~/auth/domain';
import { buildAuditContext } from '~/admin/context';

/**
 * HTTP handlers of the platform model catalog (fork-only, see `catalog.ts`).
 *
 * - The operator API (`/api/platform`, behind `PLATFORM_API_TOKEN`) manages platform providers
 *   and assigns them to tenants. Only the admin app's server holds the token; the proxy keeps
 *   the path off public hosts.
 * - The tenant admin API (`/api/admin/catalog`) shows a tenant its catalog and, when the
 *   operator opted it in, manages endpoints with the tenant's own key.
 *
 * Keys are write-only: responses carry at most a masked preview.
 */

export interface PlatformCatalogHandlerDeps {
  catalog: Pick<
    PlatformCatalogMethods,
    | 'listPlatformProviders'
    | 'findPlatformProviders'
    | 'findCatalogProviders'
    | 'upsertPlatformProvider'
    | 'deletePlatformProvider'
    | 'tenantsUsingProvider'
    | 'getTenantCatalog'
    | 'setTenantAssignments'
    | 'upsertOwnEndpoint'
    | 'deleteOwnEndpoint'
  >;
  encrypt(value: string): string;
  decrypt(value: string): string;
  /** The base config (`getAppConfig({ baseOnly: true })`), whose endpoint names catalog names must not reuse. */
  getBaseConfig(): Promise<AppConfig>;
  /** Defaults to upstream's SSRF check for endpoint URLs (`validateEndpointURL`). */
  isAllowedTenantURL?(url: string): Promise<boolean>;
  /** Drops cached endpoints and merged configs, for one tenant or all. */
  invalidate(tenantId?: string): Promise<void>;
  /** The platform agents that run on a provider; such a provider cannot be deleted. */
  agentsUsingProvider?(name: string): Promise<string[]>;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MODEL = z.string().trim().min(1).max(128);
const MAX_MODELS = 100;
const MAX_ASSIGNMENTS = 50;
const MAX_OWN_ENDPOINTS = 10;

const modelsSchema = z
  .array(MODEL)
  .min(1)
  .max(MAX_MODELS)
  .transform((models) => [...new Set(models)]);

/** Request fields an endpoint rejects, e.g. `user`; omitted means the catalog's default. */
const dropParamsSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
  .max(32)
  .transform((params) => [...new Set(params)])
  .optional();

const httpURL = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), 'must be http or https');

const providerInputSchema = z
  .object({
    label: z.string().trim().min(1).max(64),
    baseURL: httpURL,
    /** Omitted on an update: the stored key stays. */
    apiKey: z.string().trim().min(1).max(4096).optional(),
    models: modelsSchema,
    region: z.string().trim().max(64).optional(),
    /** ISO 3166-1 alpha-2 code of the hosting country. */
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .transform((code) => code.toUpperCase())
      .optional(),
    dropParams: dropParamsSchema,
    /** Offered to every tenant with all its models; omitted on an update: the stored value stays. */
    allTenants: z.boolean().optional(),
    /** Fork: the provider's queue limits; omitted removes them (no queue). */
    limits: providerLimitsSchema.optional(),
  })
  .strict();

const tenantCatalogInputSchema = z
  .object({
    byok: z.boolean(),
    providers: z
      .array(z.object({ name: z.string().regex(NAME), models: modelsSchema }).strict())
      .max(MAX_ASSIGNMENTS),
  })
  .strict();

const ownEndpointInputSchema = z
  .object({
    baseURL: httpURL.refine((value) => new URL(value).protocol === 'https:', 'must be https'),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    models: modelsSchema,
    dropParams: dropParamsSchema,
  })
  .strict();

/** Like the admin config API's previews: the last four characters of a long key only. */
function preview(encrypted: string, decrypt: (value: string) => string): string {
  try {
    const key = decrypt(encrypted);
    return key.length < 16 ? '*'.repeat(key.length) : `...${key.slice(-4)}`;
  } catch {
    return '';
  }
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * Guards the operator API. Answers 404 while no token is configured, so the API does not exist
 * for deployments that do not use it, and 401 for a wrong token.
 */
export function requirePlatformToken(
  token: string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  const expected = token && token.length >= 32 ? digest(token) : undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const header = req.get('Authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!given || !crypto.timingSafeEqual(digest(given), expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/** The operator the admin app acts for, from `X-Platform-Operator` (recorded, not trusted for access). */
export function operatorActor(req: Request): AuditActorInput {
  const id = req.get('X-Platform-Operator')?.trim();
  const valid = id && /^[A-Za-z0-9@._:-]{1,128}$/.test(id) ? id : undefined;
  return { type: 'service', id: valid ?? 'platform-operator', name: valid ?? 'Platform operator' };
}

/** Records an operator API write in the audit log, as the operator the admin app names. */
export type OperatorAudit = (
  req: Request,
  event: Omit<RecordAuditEntryInput, 'actor' | 'context'>,
) => Promise<void>;

export function createOperatorAudit(options: {
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
  logPrefix: string;
}): OperatorAudit {
  return async (req, event) => {
    const input: RecordAuditEntryInput = {
      ...event,
      actor: operatorActor(req),
      context: buildAuditContext(req as ServerRequest),
    };
    if (options.auditFailClosed && options.recordAuditEntry) {
      await options.recordAuditEntry(input, { failClosed: true });
      return;
    }
    await recordSystemAuditEntry(options.recordAuditEntry, input, options.logPrefix);
  };
}

type OperatorHandler = (req: Request, res: Response) => Promise<Response>;
type AdminHandler = (req: ServerRequest, res: Response) => Promise<Response>;

export interface PlatformCatalogHandlers {
  listProviders: OperatorHandler;
  putProvider: OperatorHandler;
  deleteProvider: OperatorHandler;
  getTenantCatalog: OperatorHandler;
  putTenantCatalog: OperatorHandler;
  getOwnCatalog: AdminHandler;
  putOwnEndpoint: AdminHandler;
  deleteOwnEndpoint: AdminHandler;
}

export function createPlatformCatalogHandlers(
  deps: PlatformCatalogHandlerDeps,
): PlatformCatalogHandlers {
  const { catalog, encrypt, decrypt } = deps;
  const isAllowedTenantURL =
    deps.isAllowedTenantURL ??
    ((url: string) =>
      validateEndpointURL(url, 'tenant endpoint').then(
        () => true,
        () => false,
      ));
  const yamlEndpointNames = async () =>
    ((await deps.getBaseConfig()).config?.endpoints?.custom ?? []).map((e) => e.name ?? '');
  const emitAdminAudit = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[platformCatalog]',
  });

  const auditOperator = createOperatorAudit({
    recordAuditEntry: deps.recordAuditEntry,
    auditFailClosed: deps.auditFailClosed,
    logPrefix: '[platformCatalog]',
  });

  function fail(res: Response, label: string, error: unknown): Response {
    logger.error(`[platformCatalog] ${label} failed`, getSafeErrorMetadata(error));
    return res.status(500).json({ error: 'Internal server error' });
  }

  async function takenNames(): Promise<Set<string>> {
    const [yaml, providers] = await Promise.all([
      yamlEndpointNames(),
      catalog.listPlatformProviders(),
    ]);
    return new Set([...yaml, ...providers.map((p) => p.name)].map((n) => n.toLowerCase()));
  }

  function providerView(provider: PlatformProvider, tenants?: string[]) {
    return {
      name: provider.name,
      label: provider.label,
      baseURL: provider.baseURL,
      models: provider.models,
      ...(provider.region && { region: provider.region }),
      ...(provider.country && { country: provider.country }),
      ...(provider.dropParams && { dropParams: provider.dropParams }),
      allTenants: provider.allTenants === true,
      ...(provider.limits && { limits: provider.limits }),
      apiKeyPreview: preview(provider.apiKey, decrypt),
      ...(tenants && { tenants }),
    };
  }

  /** GET /api/platform/providers */
  async function listProviders(_req: Request, res: Response) {
    try {
      const providers = await catalog.listPlatformProviders();
      const tenants = await Promise.all(providers.map((p) => catalog.tenantsUsingProvider(p.name)));
      return res.json({ providers: providers.map((p, i) => providerView(p, tenants[i])) });
    } catch (error) {
      return fail(res, 'provider list', error);
    }
  }

  /** PUT /api/platform/providers/:name */
  async function putProvider(req: Request, res: Response) {
    try {
      const name = String((req.params as { name?: string }).name ?? '');
      const parsed = providerInputSchema.safeParse(req.body);
      if (!NAME.test(name) || !parsed.success) {
        return res.status(400).json({ error: 'invalid_provider' });
      }
      const [existing] = await catalog.findPlatformProviders([name]);
      if (!existing) {
        const yaml = (await yamlEndpointNames()).map((n) => n.toLowerCase());
        if (yaml.includes(name.toLowerCase())) {
          return res.status(409).json({ error: 'name_taken' });
        }
      }
      const { apiKey, allTenants, ...fields } = parsed.data;
      if (!existing && !apiKey) return res.status(400).json({ error: 'api_key_required' });
      const saved = await catalog.upsertPlatformProvider({
        name,
        ...fields,
        allTenants: allTenants ?? existing?.allTenants === true,
        apiKey: apiKey ? encrypt(apiKey) : existing!.apiKey,
      });
      await deps.invalidate();
      await auditOperator(req, {
        action: 'catalog.provider_updated',
        outcome: 'success',
        severity: 'info',
        tenantId: undefined,
        target: { type: 'provider', id: name, name: saved.label },
        metadata: {
          created: !existing,
          keyChanged: Boolean(apiKey),
          models: saved.models.length,
          allTenants: saved.allTenants === true,
          queued: saved.limits != null,
        },
      });
      return res.status(existing ? 200 : 201).json({ provider: providerView(saved) });
    } catch (error) {
      return fail(res, 'provider update', error);
    }
  }

  /**
   * DELETE /api/platform/providers/:name; refused while it is offered to all tenants, a tenant
   * has it or a platform agent runs on it.
   */
  async function deleteProvider(req: Request, res: Response) {
    try {
      const name = String((req.params as { name?: string }).name ?? '');
      const [stored] = await catalog.findPlatformProviders([name]);
      if (stored?.allTenants) {
        return res.status(409).json({ error: 'provider_for_all_tenants' });
      }
      const tenants = await catalog.tenantsUsingProvider(name);
      if (tenants.length > 0) {
        return res.status(409).json({ error: 'provider_in_use', tenants });
      }
      const agents = (await deps.agentsUsingProvider?.(name)) ?? [];
      if (agents.length > 0) {
        return res.status(409).json({ error: 'provider_used_by_agents', agents });
      }
      if (!(await catalog.deletePlatformProvider(name))) {
        return res.status(404).json({ error: 'not_found' });
      }
      await auditOperator(req, {
        action: 'catalog.provider_deleted',
        outcome: 'success',
        severity: 'info',
        tenantId: undefined,
        target: { type: 'provider', id: name },
      });
      return res.status(204).end();
    } catch (error) {
      return fail(res, 'provider delete', error);
    }
  }

  function tenantOf(req: Request, res: Response): string | null {
    const tenantId = String((req.params as { tenantId?: string }).tenantId ?? '');
    if (!TENANT_ID.test(tenantId) || tenantId === '__SYSTEM__') {
      res.status(400).json({ error: 'invalid_tenant' });
      return null;
    }
    return tenantId;
  }

  /** GET /api/platform/tenants/:tenantId/catalog */
  async function getTenantCatalog(req: Request, res: Response) {
    try {
      const tenantId = tenantOf(req, res);
      if (!tenantId) return res;
      const stored = await catalog.getTenantCatalog(tenantId);
      return res.json({
        byok: stored?.byok ?? false,
        providers: stored?.providers ?? [],
        own: (stored?.own ?? []).map(({ name, baseURL, models }) => ({ name, baseURL, models })),
      });
    } catch (error) {
      return fail(res, 'tenant catalog read', error);
    }
  }

  /** PUT /api/platform/tenants/:tenantId/catalog: the tenant's providers and models, and BYOK. */
  async function putTenantCatalog(req: Request, res: Response) {
    try {
      const tenantId = tenantOf(req, res);
      if (!tenantId) return res;
      const parsed = tenantCatalogInputSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_catalog' });
      const { byok, providers } = parsed.data;
      const names = providers.map((p) => p.name);
      if (new Set(names).size !== names.length) {
        return res.status(400).json({ error: 'invalid_catalog' });
      }
      const known = new Map(
        (await catalog.findPlatformProviders(names)).map((p) => [p.name, new Set(p.models)]),
      );
      const outside = providers.some(
        (p) => !known.has(p.name) || p.models.some((m) => !known.get(p.name)!.has(m)),
      );
      if (outside) return res.status(400).json({ error: 'unknown_provider_or_model' });
      const assignments: CatalogAssignment[] = providers;
      const saved = await catalog.setTenantAssignments(tenantId, { byok, providers: assignments });
      await deps.invalidate(tenantId);
      await auditOperator(req, {
        action: 'catalog.tenant_updated',
        outcome: 'success',
        severity: 'info',
        tenantId,
        target: { type: 'tenant', id: tenantId },
        metadata: { byok, providers: names.join(',') },
      });
      return res.json({ byok: saved.byok, providers: saved.providers });
    } catch (error) {
      return fail(res, 'tenant catalog update', error);
    }
  }

  /** The caller's tenant; tenant admin routes run in it. */
  function callerTenant(req: ServerRequest, res: Response): string | null {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ error: 'tenant_required' });
      return null;
    }
    return tenantId;
  }

  /**
   * GET /api/admin/catalog: the tenant's assigned providers, the providers offered to all
   * tenants (with all their models) and its own endpoints.
   */
  async function getOwnCatalog(req: ServerRequest, res: Response) {
    try {
      const tenantId = callerTenant(req, res);
      if (!tenantId) return res;
      const stored = await catalog.getTenantCatalog(tenantId);
      const providers = await catalog.findCatalogProviders(
        (stored?.providers ?? []).map((p) => p.name),
      );
      const byName = new Map(providers.map((p) => [p.name, p]));
      const view = (provider: PlatformProvider, models: string[]) => ({
        name: provider.name,
        label: provider.label,
        ...(provider.region && { region: provider.region }),
        ...(provider.country && { country: provider.country }),
        models,
        allTenants: provider.allTenants === true,
      });
      const assigned = (stored?.providers ?? [])
        .filter((p) => byName.has(p.name) && !byName.get(p.name)!.allTenants)
        .map((p) => view(byName.get(p.name)!, p.models));
      const forAll = providers.filter((p) => p.allTenants).map((p) => view(p, p.models));
      return res.json({
        byok: stored?.byok ?? false,
        providers: [...assigned, ...forAll],
        own: (stored?.own ?? []).map((own) => ({
          name: own.name,
          baseURL: own.baseURL,
          models: own.models,
          ...(own.dropParams && { dropParams: own.dropParams }),
          apiKeyPreview: preview(own.apiKey, decrypt),
        })),
      });
    } catch (error) {
      return fail(res, 'own catalog read', error);
    }
  }

  /** PUT /api/admin/catalog/own/:name: an endpoint with the tenant's own key. */
  async function putOwnEndpoint(req: ServerRequest, res: Response) {
    try {
      const tenantId = callerTenant(req, res);
      if (!tenantId) return res;
      const name = String((req.params as { name?: string }).name ?? '');
      const parsed = ownEndpointInputSchema.safeParse(req.body);
      if (!NAME.test(name) || !parsed.success) {
        return res.status(400).json({ error: 'invalid_endpoint' });
      }
      const stored = await catalog.getTenantCatalog(tenantId);
      if (!stored?.byok) return res.status(403).json({ error: 'byok_not_enabled' });
      const existing = stored.own.find((own) => own.name === name);
      if (!existing) {
        if (stored.own.length >= MAX_OWN_ENDPOINTS) {
          return res.status(409).json({ error: 'too_many_endpoints' });
        }
        if ((await takenNames()).has(name.toLowerCase())) {
          return res.status(409).json({ error: 'name_taken' });
        }
      }
      const { apiKey, baseURL, models, dropParams } = parsed.data;
      if (!existing && !apiKey) return res.status(400).json({ error: 'api_key_required' });
      if (!(await isAllowedTenantURL(baseURL))) {
        return res.status(400).json({ error: 'url_not_allowed' });
      }
      await catalog.upsertOwnEndpoint(tenantId, {
        name,
        baseURL,
        models,
        ...(dropParams && { dropParams }),
        apiKey: apiKey ? encrypt(apiKey) : existing!.apiKey,
      });
      await deps.invalidate(tenantId);
      await emitAdminAudit(req, {
        action: 'catalog.own_endpoint_updated',
        outcome: 'success',
        severity: 'info',
        target: { type: 'endpoint', id: name },
        metadata: { created: !existing, keyChanged: Boolean(apiKey), models: models.length },
      });
      return res
        .status(existing ? 200 : 201)
        .json({ name, baseURL, models, ...(dropParams && { dropParams }) });
    } catch (error) {
      return fail(res, 'own endpoint update', error);
    }
  }

  /** DELETE /api/admin/catalog/own/:name */
  async function deleteOwnEndpoint(req: ServerRequest, res: Response) {
    try {
      const tenantId = callerTenant(req, res);
      if (!tenantId) return res;
      const name = String((req.params as { name?: string }).name ?? '');
      if (!(await catalog.deleteOwnEndpoint(tenantId, name))) {
        return res.status(404).json({ error: 'not_found' });
      }
      await deps.invalidate(tenantId);
      await emitAdminAudit(req, {
        action: 'catalog.own_endpoint_deleted',
        outcome: 'success',
        severity: 'info',
        target: { type: 'endpoint', id: name },
      });
      return res.status(204).end();
    } catch (error) {
      return fail(res, 'own endpoint delete', error);
    }
  }

  return {
    listProviders,
    putProvider,
    deleteProvider,
    getTenantCatalog,
    putTenantCatalog,
    getOwnCatalog,
    putOwnEndpoint,
    deleteOwnEndpoint,
  };
}
