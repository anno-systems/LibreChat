import { z } from 'zod';
import crypto from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { locationSchema, queueSettingsSchema } from 'librechat-data-provider';
import type {
  AppConfig,
  CatalogModel,
  AuditActorInput,
  PlatformProvider,
  CatalogAssignment,
  RecordAuditEntryInput,
  PlatformCatalogMethods,
} from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { ModelRemovalGuard, Successor } from '~/migration/guard';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import {
  hasModel,
  uniqueSlug,
  ownModelsSchema,
  tenantModelView,
  providerModelsSchema,
} from './models';
import { createAdminAuditEmitter, recordSystemAuditEntry } from '~/admin/audit';
import { createCatalogModelCheck, successorsSchema } from '~/migration/guard';
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
    | 'createPlatformProvider'
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
  /**
   * Fork: refuses provider and tenant assignment updates that drop a model agents or
   * conversations still use, unless it is redirected (`migration/guard.ts`). Absent, models are
   * dropped unchecked, as before.
   */
  modelGuard?: ModelRemovalGuard;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MODEL = z.string().trim().min(1).max(128);
const MAX_MODELS = 100;
const MAX_ASSIGNMENTS = 50;
/** Attempts at a generated provider name when concurrent creates take the same one. */
const MAX_CREATE_ATTEMPTS = 5;
const MAX_OWN_ENDPOINTS = 10;

/** Model ids of a tenant assignment. */
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
    /** The display name; can change at any time, unlike `name`. */
    label: z.string().trim().min(1).max(64),
    baseURL: httpURL,
    /** Omitted on an update: the stored key stays. */
    apiKey: z.string().trim().min(1).max(4096).optional(),
    /** `{ id, label?, location?, limits? }` per model; a model with limits gets its own queue. */
    models: providerModelsSchema,
    /** Default location of the models; omitted removes it. */
    location: locationSchema.optional(),
    dropParams: dropParamsSchema,
    /** Offered to every tenant with all its models; omitted on an update: the stored value stays. */
    allTenants: z.boolean().optional(),
    /** Maximum wait and pause after a 429 of every model's queue; omitted removes them. */
    queue: queueSettingsSchema.optional(),
    /** Successors of dropped models, migrated before the update (`migration/guard.ts`). */
    successors: successorsSchema,
  })
  .strict();

/** A create may name the provider; otherwise the name is derived from the label. */
const providerCreateSchema = providerInputSchema.extend({
  name: z.string().regex(NAME).optional(),
});

type ProviderInput = z.infer<typeof providerInputSchema>;

const tenantCatalogInputSchema = z
  .object({
    byok: z.boolean(),
    providers: z
      .array(z.object({ name: z.string().regex(NAME), models: modelsSchema }).strict())
      .max(MAX_ASSIGNMENTS),
    /** Successors of dropped models, migrated for the tenant before the update. */
    successors: successorsSchema,
  })
  .strict();

const ownEndpointInputSchema = z
  .object({
    baseURL: httpURL.refine((value) => new URL(value).protocol === 'https:', 'must be https'),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    /** `{ id, label?, location? }` per model; own endpoints have no queue. */
    models: ownModelsSchema,
    /** Default location of the models; omitted removes it. */
    location: locationSchema.optional(),
    dropParams: dropParamsSchema,
  })
  .strict();

function modelIds(provider: PlatformProvider): string[] {
  return provider.models.map((model) => model.id);
}

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
  postProvider: OperatorHandler;
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
  const isCatalogModel = createCatalogModelCheck({
    getBaseConfig: deps.getBaseConfig,
    findPlatformProviders: catalog.findPlatformProviders,
  });

  /**
   * Fork: runs the model guard for an update that drops `removed`; answers and returns false
   * when the update must not go ahead.
   */
  async function guardRemoval(
    req: Request,
    res: Response,
    params: Omit<Parameters<ModelRemovalGuard['check']>[0], 'successors'> & {
      successors: Successor[];
    },
  ): Promise<boolean> {
    if (!deps.modelGuard) {
      if (params.successors.length === 0) return true;
      res.status(400).json({ error: 'invalid_successor' });
      return false;
    }
    const check = await deps.modelGuard.check(params);
    if (!check.ok) {
      res.status(check.status).json(check.body);
      return false;
    }
    if (!(await deps.modelGuard.migrate(req, params.scope, params.successors))) {
      res.status(409).json({ error: 'redirect_cycle' });
      return false;
    }
    return true;
  }

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
      ...(provider.location && { location: provider.location }),
      models: provider.models,
      ...(provider.dropParams && { dropParams: provider.dropParams }),
      allTenants: provider.allTenants === true,
      ...(provider.queue && { queue: provider.queue }),
      apiKeyPreview: preview(provider.apiKey, decrypt),
      ...(tenants && { tenants }),
    };
  }

  /**
   * Successors on the provider being written carry its model labels (the new models' for a
   * target), so migration notices show display names; labels the caller gave win.
   */
  function labelledSuccessors(
    name: string,
    successors: Successor[],
    before: CatalogModel[],
    after: CatalogModel[],
  ): Successor[] {
    const labelOf = (models: CatalogModel[], ref: Successor['from']) =>
      ref.label ??
      (ref.endpoint === name ? models.find((m) => m.id === ref.model)?.label : undefined);
    return successors.map(({ from, to }) => {
      const fromLabel = labelOf(before, from);
      const toLabel = labelOf(after, to);
      return {
        from: fromLabel ? { ...from, label: fromLabel } : from,
        to: toLabel ? { ...to, label: toLabel } : to,
      };
    });
  }

  /**
   * Writes a provider if the model guard allows it: `existing` is the stored provider of an
   * update, absent for a create. Answers the request, except for a create whose name another
   * provider took meanwhile (`name_taken`), which the caller answers or retries.
   */
  async function saveProvider(
    req: Request,
    res: Response,
    name: string,
    existing: PlatformProvider | undefined,
    input: ProviderInput,
  ): Promise<Response | 'name_taken'> {
    const { apiKey, allTenants, successors = [], ...fields } = input;
    if (!existing && !apiKey) return res.status(400).json({ error: 'api_key_required' });
    const kept = new Set(fields.models.map((model) => model.id));
    const allowed = await guardRemoval(req, res, {
      removed: (existing?.models ?? [])
        .filter((model) => !kept.has(model.id))
        .map((model) => ({ endpoint: name, model: model.id })),
      scope: { platform: true },
      successors: labelledSuccessors(name, successors, existing?.models ?? [], fields.models),
      isTarget: async (ref) => (ref.endpoint === name ? kept.has(ref.model) : isCatalogModel(ref)),
    });
    if (!allowed) return res;
    const provider: PlatformProvider = {
      name,
      ...fields,
      allTenants: allTenants ?? existing?.allTenants === true,
      apiKey: apiKey ? encrypt(apiKey) : existing!.apiKey,
    };
    let saved: PlatformProvider;
    if (existing) {
      saved = await catalog.upsertPlatformProvider(provider);
    } else {
      const created = await catalog.createPlatformProvider(provider);
      if (!created.ok) return 'name_taken';
      saved = created.value;
    }
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
        queued: saved.models.some((model) => model.limits != null),
      },
    });
    return res.status(existing ? 200 : 201).json({ provider: providerView(saved) });
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

  /**
   * POST /api/platform/providers: creates a provider. Its name (the fixed endpoint id) is the
   * caller's `name`, or else derived from the label: a slug unique among providers and
   * `librechat.yaml` endpoints, with `-2`, `-3` on a collision.
   */
  async function postProvider(req: Request, res: Response) {
    try {
      const parsed = providerCreateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_provider' });
      const { name: given, ...input } = parsed.data;
      if (given) {
        if ((await takenNames()).has(given.toLowerCase())) {
          return res.status(409).json({ error: 'name_taken' });
        }
        const saved = await saveProvider(req, res, given, undefined, input);
        return saved === 'name_taken' ? res.status(409).json({ error: 'name_taken' }) : saved;
      }
      /** A concurrent create can take the slug between the check and the insert; try the next. */
      const tried = new Set<string>();
      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
        const taken = new Set([...(await takenNames()), ...tried]);
        const name = uniqueSlug(input.label, taken);
        if (!name) break;
        tried.add(name);
        const saved = await saveProvider(req, res, name, undefined, input);
        if (saved !== 'name_taken') return saved;
      }
      return res.status(409).json({ error: 'name_taken' });
    } catch (error) {
      return fail(res, 'provider create', error);
    }
  }

  /**
   * PUT /api/platform/providers/:name: updates a provider (the name never changes); creates one
   * under that exact name when none has it, as before `POST`.
   */
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
      const saved = await saveProvider(req, res, name, existing, parsed.data);
      return saved === 'name_taken' ? res.status(409).json({ error: 'name_taken' }) : saved;
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
        own: (stored?.own ?? []).map(({ name, baseURL, location, models }) => ({
          name,
          baseURL,
          ...(location && { location }),
          models,
        })),
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
      const { byok, providers, successors = [] } = parsed.data;
      const names = providers.map((p) => p.name);
      if (new Set(names).size !== names.length) {
        return res.status(400).json({ error: 'invalid_catalog' });
      }
      const known = new Map(
        (await catalog.findPlatformProviders(names)).map((p) => [p.name, new Set(modelIds(p))]),
      );
      const outside = providers.some(
        (p) => !known.has(p.name) || p.models.some((m) => !known.get(p.name)!.has(m)),
      );
      if (outside) return res.status(400).json({ error: 'unknown_provider_or_model' });
      if (!(await guardTenantRemoval(req, res, tenantId, providers, successors))) return res;
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

  /**
   * Fork: the models a tenant assignment update takes from the tenant (a provider offered to all
   * tenants keeps its models) go through the model guard, for that tenant only.
   */
  async function guardTenantRemoval(
    req: Request,
    res: Response,
    tenantId: string,
    providers: CatalogAssignment[],
    successors: Successor[],
  ): Promise<boolean> {
    const previous = (await catalog.getTenantCatalog(tenantId))?.providers ?? [];
    const assigned = new Map(providers.map((p) => [p.name, new Set(p.models)]));
    const stored = new Map(
      (
        await catalog.findPlatformProviders([
          ...new Set([...previous.map((p) => p.name), ...providers.map((p) => p.name)]),
        ])
      ).map((p) => [p.name, p]),
    );
    const forAll = (name: string, model: string) =>
      stored.get(name)?.allTenants === true && hasModel(stored.get(name)!, model);
    const removed = previous.flatMap((p) =>
      p.models
        .filter((model) => !assigned.get(p.name)?.has(model) && !forAll(p.name, model))
        .map((model) => ({ endpoint: p.name, model })),
    );
    return guardRemoval(req, res, {
      removed,
      scope: { platform: true, tenantIds: [tenantId] },
      successors,
      isTarget: async (ref) => {
        if (assigned.get(ref.endpoint)?.has(ref.model)) return true;
        const provider =
          stored.get(ref.endpoint) ?? (await catalog.findPlatformProviders([ref.endpoint]))[0];
        if (provider) return provider.allTenants === true && hasModel(provider, ref.model);
        return isCatalogModel(ref);
      },
    });
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
      /** Each model with its display name and effective location; limits stay the operator's. */
      const view = (provider: PlatformProvider, ids: string[]) => {
        const listed = new Set(ids);
        return {
          name: provider.name,
          label: provider.label,
          models: provider.models
            .filter((model) => listed.has(model.id))
            .map((model) => tenantModelView(model, provider)),
          allTenants: provider.allTenants === true,
        };
      };
      const assigned = (stored?.providers ?? [])
        .filter((p) => byName.has(p.name) && !byName.get(p.name)!.allTenants)
        .map((p) => view(byName.get(p.name)!, p.models));
      const forAll = providers.filter((p) => p.allTenants).map((p) => view(p, modelIds(p)));
      return res.json({
        byok: stored?.byok ?? false,
        providers: [...assigned, ...forAll],
        own: (stored?.own ?? []).map((own) => ({
          name: own.name,
          baseURL: own.baseURL,
          ...(own.location && { location: own.location }),
          models: own.models.map((model) => tenantModelView(model, own)),
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
      const { apiKey, baseURL, models, location, dropParams } = parsed.data;
      if (!existing && !apiKey) return res.status(400).json({ error: 'api_key_required' });
      if (!(await isAllowedTenantURL(baseURL))) {
        return res.status(400).json({ error: 'url_not_allowed' });
      }
      await catalog.upsertOwnEndpoint(tenantId, {
        name,
        baseURL,
        models,
        ...(location && { location }),
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
      return res.status(existing ? 200 : 201).json({
        name,
        baseURL,
        ...(location && { location }),
        models: models.map((model) => tenantModelView(model, { location })),
        ...(dropParams && { dropParams }),
      });
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
    postProvider,
    putProvider,
    deleteProvider,
    getTenantCatalog,
    putTenantCatalog,
    getOwnCatalog,
    putOwnEndpoint,
    deleteOwnEndpoint,
  };
}
