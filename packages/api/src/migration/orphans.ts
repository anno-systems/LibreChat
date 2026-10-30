import { logger, tenantStorage } from '@librechat/data-schemas';
import { EModelEndpoint, extractEnvVariable, normalizeEndpointName } from 'librechat-data-provider';
import type {
  AppConfig,
  ModelRef,
  UsedModel,
  ModelRedirect,
  MigrationAudience,
  ModelMigrationMethods,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { resolveServedCustomEndpoints } from '~/endpoints/custom/config';
import { configuredModelList } from '~/endpoints/config/models';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isUserProvided } from '~/utils/common';
import { findRedirect } from './redirect';
import { TENANT_ID } from './handlers';

/**
 * Orphaned models (fork-only): the (endpoint, model) pairs a tenant's agents and active
 * conversations name that the tenant can no longer use, so the operator or the tenant's admin can
 * find them and rescue them with an ordinary model migration to a successor.
 *
 * "Usable" is read from the tenant-wide config the app serves the tenant (`getAppConfig` with
 * its catalog endpoints, librechat.yaml's and its own BYOK endpoints, narrowed by its config
 * documents). Where the model list cannot be known without asking the provider (a fetched list,
 * a user-provided key or URL, a built-in endpoint without a configured list), every model of the
 * endpoint counts as usable, so nothing is called orphaned that might still run.
 */

/** A model the tenant's documents name that the tenant cannot use. */
export interface OrphanedModel {
  tenantId: string;
  /** The stored endpoint (an agent's `provider`); pass it unchanged as a migration's `from`. */
  endpoint: string;
  model: string;
  /** The redirect's stored label, else the configuration's or the catalog's, when known. */
  label?: string;
  agents: number;
  conversations: number;
  /** A redirect already moves requests for this model on; its documents still name it. */
  redirected: boolean;
}

/** Endpoints whose model belongs to something else (an agent, an assistant): never orphaned. */
const DELEGATED_ENDPOINTS = new Set<string>([
  EModelEndpoint.agents,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
]);
const BUILT_IN_ENDPOINTS = new Set<string>(
  Object.values(EModelEndpoint).filter((e) => e !== EModelEndpoint.custom),
);
/** Agent providers stored under another name than the endpoint they run on. */
const PROVIDER_ENDPOINTS: Record<string, string> = { vertexai: EModelEndpoint.google };

/** All models of an endpoint (`'*'`), or the listed ones. */
type ModelList = '*' | Set<string>;

function namesOf(models: readonly unknown[] | undefined): Set<string> {
  return new Set(
    (models ?? []).map((m) =>
      typeof m === 'string' ? m : String((m as { name?: string } | null)?.name ?? ''),
    ),
  );
}

/**
 * Whether a tenant can use a model, from its tenant-wide config. `builtinEndpoints` are the
 * built-in endpoints the deployment serves (credentials set); a built-in endpoint absent there and
 * from the config is not usable.
 */
export function createUsableModelCheck(
  appConfig: AppConfig,
  builtinEndpoints: readonly string[],
): (ref: ModelRef) => boolean {
  const lists = new Map<string, ModelList>();
  const custom = (appConfig.endpoints?.[EModelEndpoint.custom] ?? []) as Parameters<
    typeof resolveServedCustomEndpoints
  >[0];
  for (const [name, endpoint] of resolveServedCustomEndpoints(custom)) {
    const open =
      endpoint.models?.fetch === true ||
      isUserProvided(extractEnvVariable(String(endpoint.apiKey ?? ''))) ||
      isUserProvided(extractEnvVariable(String(endpoint.baseURL ?? '')));
    lists.set(name, open ? '*' : namesOf(endpoint.models?.default));
  }

  const configured = new Set(builtinEndpoints);
  const endpoints = (appConfig.endpoints ?? {}) as Record<string, unknown>;
  for (const name of BUILT_IN_ENDPOINTS) {
    if (DELEGATED_ENDPOINTS.has(name)) continue;
    if (!configured.has(name) && endpoints[name] == null) continue;
    if (name === EModelEndpoint.azureOpenAI) {
      const { modelNames } = appConfig.endpoints?.[EModelEndpoint.azureOpenAI] ?? {};
      lists.set(name, modelNames ? new Set(modelNames) : '*');
      continue;
    }
    const listed =
      name === EModelEndpoint.openAI ||
      name === EModelEndpoint.google ||
      name === EModelEndpoint.anthropic ||
      name === EModelEndpoint.bedrock
        ? configuredModelList(appConfig, name)
        : undefined;
    lists.set(name, listed ? new Set(listed) : '*');
  }

  return (ref) => {
    if (DELEGATED_ENDPOINTS.has(ref.endpoint)) return true;
    const endpoint = PROVIDER_ENDPOINTS[ref.endpoint] ?? ref.endpoint;
    const list =
      lists.get(endpoint) ??
      (BUILT_IN_ENDPOINTS.has(endpoint) ? undefined : lists.get(normalizeEndpointName(endpoint)));
    if (!list) return false;
    return list === '*' || list.has(ref.model);
  };
}

/** The operator's (every or listed tenants) or one tenant's admin's. */
export type OrphanScope = { tenantId: string } | { tenantIds?: string[] };

export interface OrphanedModelFinderDeps {
  listUsedModels: ModelMigrationMethods['listUsedModels'];
  getModelRedirects(): readonly ModelRedirect[];
  /** The tenant-wide config (no role, group or user overrides), as the app serves it. */
  getTenantAppConfig(tenantId: string): Promise<AppConfig>;
  /** The built-in endpoints the deployment serves (`loadDefaultEndpointsConfig`). */
  builtinEndpoints(): Promise<string[]>;
  /** The configuration's display name of a model (`createModelLabelLookup`). */
  labelOf?(ref: ModelRef, tenantId?: string): Promise<string | undefined>;
}

export interface OrphanedModelFinder {
  find(scope: OrphanScope): Promise<OrphanedModel[]>;
  /**
   * The listed tenants that can use neither `from` nor `to`: a migration there would move what
   * names an orphaned model to another model the tenant cannot run, since only a tenant that has
   * `from` enabled gets the successor enabled with it.
   */
  unusableTargetTenants(tenantIds: string[], from: ModelRef, to: ModelRef): Promise<string[]>;
}

/** Tenants whose configs are read at once. */
const TENANT_BATCH = 5;

async function mapInBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += TENANT_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + TENANT_BATCH).map(fn))));
  }
  return out;
}

export function createOrphanedModelFinder(deps: OrphanedModelFinderDeps): OrphanedModelFinder {
  /** One usable-model check per tenant, read in that tenant's context. */
  async function checksFor(tenantIds: string[]) {
    const builtins = await deps.builtinEndpoints();
    const checks = await mapInBatches(tenantIds, async (tenantId) => {
      const config = await tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, () =>
        deps.getTenantAppConfig(tenantId),
      );
      return [tenantId, createUsableModelCheck(config, builtins)] as const;
    });
    return new Map(checks);
  }

  async function labelled(orphan: OrphanedModel, redirect?: ModelRedirect) {
    const label =
      redirect?.from.label ??
      (await deps.labelOf?.(orphan, orphan.tenantId).catch((error: unknown) => {
        logger.warn('[modelOrphans] label lookup failed', getSafeErrorMetadata(error));
        return undefined;
      }));
    return label ? { ...orphan, label } : orphan;
  }

  return {
    async find(scope) {
      let audience: MigrationAudience = { all: true };
      if ('tenantId' in scope) audience = { tenantId: scope.tenantId };
      else if (scope.tenantIds) audience = { tenantIds: scope.tenantIds };
      const used: UsedModel[] = await deps.listUsedModels(audience, {
        exceptConversationEndpoints: [...DELEGATED_ENDPOINTS],
      });
      if (used.length === 0) return [];
      const checks = await checksFor([...new Set(used.map((u) => u.tenantId))]);
      const redirects = deps.getModelRedirects();
      const orphans = used.filter((u) => !checks.get(u.tenantId)?.(u));
      const result = await mapInBatches(orphans, (u) => {
        const ref = { endpoint: u.endpoint, model: u.model };
        const redirect = findRedirect(redirects, u.tenantId, ref);
        return labelled(
          {
            tenantId: u.tenantId,
            ...ref,
            agents: u.agents,
            conversations: u.conversations,
            redirected: redirect != null,
          },
          redirect,
        );
      });
      return result.sort(
        (a, b) =>
          a.tenantId.localeCompare(b.tenantId) ||
          a.endpoint.localeCompare(b.endpoint) ||
          a.model.localeCompare(b.model),
      );
    },

    async unusableTargetTenants(tenantIds, from, to) {
      const checks = await checksFor(tenantIds);
      return tenantIds.filter((id) => {
        const usable = checks.get(id);
        return usable != null && !usable(from) && !usable(to);
      });
    },
  };
}

function fail(res: Response, error: unknown): Response {
  logger.error('[modelOrphans] listing failed', getSafeErrorMetadata(error));
  return res.status(500).json({ error: 'Internal server error' });
}

type Handler<R> = (req: R, res: Response) => Promise<Response>;

/** GET /api/platform/orphaned-models[?tenantId=]: every tenant's, or one tenant's. */
export function createOperatorOrphanHandler(finder: OrphanedModelFinder): Handler<Request> {
  return async (req, res) => {
    try {
      const tenantId = req.query.tenantId;
      if (tenantId !== undefined && (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId))) {
        return res.status(400).json({ error: 'invalid_tenant' });
      }
      const orphans = await finder.find(tenantId ? { tenantIds: [tenantId] } : {});
      return res.json({ orphans });
    } catch (error) {
      return fail(res, error);
    }
  };
}

/** GET /api/admin/models/orphans: the caller's tenant's. */
export function createAdminOrphanHandler(finder: OrphanedModelFinder): Handler<ServerRequest> {
  return async (req, res) => {
    try {
      const tenantId = req.user?.tenantId;
      if (!tenantId) return res.status(403).json({ error: 'tenant_required' });
      return res.json({ orphans: await finder.find({ tenantId }) });
    } catch (error) {
      return fail(res, error);
    }
  };
}
