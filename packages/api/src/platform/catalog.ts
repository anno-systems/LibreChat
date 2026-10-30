import type {
  AppConfig,
  OwnModel,
  CatalogModel,
  TenantCatalog,
  PlatformProvider,
} from '@librechat/data-schemas';
import type { TEndpoint, TProviderLimits, TQueueSettings } from 'librechat-data-provider';

/**
 * Per-tenant model catalog (fork-only). Besides `librechat.yaml`'s custom endpoints, a tenant
 * gets the platform providers the operator assigned to it, limited to the assigned models, the
 * providers the operator offers to every tenant (`allTenants`), with all their models, and, when
 * the operator opted it in (`byok`), endpoints with its own key. Tenant admins narrow the models
 * further through their config (`endpoints.custom[].models.default`). They join the tenant's
 * base config as tenant-scoped custom endpoints (`tenantId`, the same scoping upstream applies
 * to YAML endpoints), so model lists, the catalog lock and chat requests treat them like YAML
 * endpoints. No other tenant ever sees them. Model display names become the endpoint's
 * `modelLabels` (the model selector shows them), and each model with limits gets its own queue
 * through `modelLimits`, with the provider's queue settings.
 *
 * The admin config API must run with `ADMIN_CONFIG_CATALOG_LOCK`: without it a tenant admin
 * could override an assigned endpoint's `baseURL` and receive the operator's key.
 */

export interface TenantEndpointLoaderDeps {
  getTenantCatalog(tenantId: string): Promise<TenantCatalog | null>;
  /** The named providers and every provider offered to all tenants. */
  findCatalogProviders(names: string[]): Promise<PlatformProvider[]>;
  /** Decrypts a stored key. */
  decrypt(value: string): string;
  /** Off without `ADMIN_CONFIG_CATALOG_LOCK` (see above): no tenant gets catalog endpoints. */
  enabled: boolean;
  /** How long a tenant's endpoints are reused; writes on this replica invalidate at once. */
  ttlMs?: number;
  now?: () => number;
}

export interface TenantEndpointLoader {
  load(tenantId: string): Promise<TEndpoint[]>;
  /** Drops one tenant's cached endpoints, or every tenant's. */
  invalidate(tenantId?: string): void;
}

/**
 * Request fields dropped for an endpoint that sets none. LibreChat sends the user's id as `user`;
 * several providers reject the field (Mistral, Azure AI Foundry models), and none of the
 * platform's providers needs it.
 */
export const DEFAULT_DROP_PARAMS: readonly string[] = ['user'];

/** Shorter than the merged config cache, so a catalog change is visible within a minute. */
const DEFAULT_TTL_MS = 30_000;

/**
 * Each limited model's queue limits with the provider's queue settings; models without limits
 * get no entry and so no queue.
 */
function modelLimitsOf(
  models: Array<CatalogModel | OwnModel>,
  queue: TQueueSettings | undefined,
): Record<string, TProviderLimits> | undefined {
  const entries = models.flatMap((model) => {
    const limits = 'limits' in model ? model.limits : undefined;
    return limits && Object.keys(limits).length > 0 ? [[model.id, { ...queue, ...limits }]] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function modelLabelsOf(models: OwnModel[]): Record<string, string> | undefined {
  const entries = models.filter((model) => model.label).map((model) => [model.id, model.label!]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function endpointOf(
  tenantId: string,
  source: {
    name: string;
    baseURL: string;
    apiKey: string;
    label?: string;
    dropParams?: string[];
    /** Platform providers only; a tenant's own endpoint has no shared queue. */
    queue?: TQueueSettings;
  },
  /** A tenant's own endpoints pass models without limits, so they never get a queue. */
  models: Array<CatalogModel | OwnModel>,
): TEndpoint {
  const modelLimits = modelLimitsOf(models, source.queue);
  const modelLabels = modelLabelsOf(models);
  return {
    ...(modelLimits && { modelLimits }),
    ...(modelLabels && { modelLabels }),
    name: source.name,
    baseURL: source.baseURL,
    apiKey: source.apiKey,
    models: { default: models.map((model) => model.id), fetch: false },
    dropParams: [...(source.dropParams ?? DEFAULT_DROP_PARAMS)],
    modelDisplayLabel: source.label ?? source.name,
    titleConvo: true,
    titleModel: 'current_model',
    tenantId,
  } as TEndpoint;
}

/** One platform provider as a tenant's custom endpoint with the given models, key decrypted. */
export function providerEndpoint(
  tenantId: string,
  provider: PlatformProvider,
  models: string[],
  decrypt: (value: string) => string,
): TEndpoint {
  const listed = new Set(models);
  return endpointOf(
    tenantId,
    { ...provider, apiKey: decrypt(provider.apiKey) },
    provider.models.filter((model) => listed.has(model.id)),
  );
}

/**
 * The endpoints a tenant gets, keys decrypted: providers offered to all tenants with all their
 * models (an assignment of one does not narrow it), assigned providers with their assigned
 * models, and with BYOK the tenant's own endpoints. Assignments of unknown providers and
 * endpoints without models are skipped.
 */
export function catalogEndpoints(
  tenantId: string,
  catalog: TenantCatalog | null,
  providers: PlatformProvider[],
  decrypt: (value: string) => string,
): TEndpoint[] {
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const endpoints: TEndpoint[] = [];
  const added = new Set<string>();
  const add = (provider: PlatformProvider, models: string[]) => {
    if (added.has(provider.name)) return;
    const endpoint = providerEndpoint(tenantId, provider, models, decrypt);
    if (endpoint.models?.default.length === 0) return;
    added.add(provider.name);
    endpoints.push(endpoint);
  };
  const ids = (provider: PlatformProvider) => provider.models.map((model) => model.id);
  for (const assignment of catalog?.providers ?? []) {
    const provider = byName.get(assignment.name);
    if (!provider) continue;
    add(provider, provider.allTenants ? ids(provider) : assignment.models);
  }
  for (const provider of providers) {
    if (provider.allTenants) add(provider, ids(provider));
  }
  if (catalog?.byok) {
    for (const own of catalog.own) {
      if (own.models.length === 0) continue;
      endpoints.push(endpointOf(tenantId, { ...own, apiKey: decrypt(own.apiKey) }, own.models));
    }
  }
  return endpoints;
}

export function createTenantEndpointLoader(deps: TenantEndpointLoaderDeps): TenantEndpointLoader {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<TEndpoint[]> }>();

  async function read(tenantId: string): Promise<TEndpoint[]> {
    const catalog = await deps.getTenantCatalog(tenantId);
    const providers = await deps.findCatalogProviders(
      (catalog?.providers ?? []).map((p) => p.name),
    );
    return catalogEndpoints(tenantId, catalog, providers, deps.decrypt);
  }

  return {
    load(tenantId) {
      if (!deps.enabled) return Promise.resolve([]);
      const cached = cache.get(tenantId);
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const value = read(tenantId);
      cache.set(tenantId, { at: now(), value });
      // A failed read is not reused; the next request tries again.
      value.catch(() => {
        if (cache.get(tenantId)?.value === value) cache.delete(tenantId);
      });
      return value;
    },
    invalidate(tenantId) {
      if (tenantId) cache.delete(tenantId);
      else cache.clear();
    },
  };
}

/**
 * The base config with a tenant's catalog endpoints added to both custom endpoint lists (the
 * loaded one and the raw YAML one the admin config API validates against).
 */
export function withTenantEndpoints(config: AppConfig, endpoints: TEndpoint[]): AppConfig {
  if (endpoints.length === 0) return config;
  const custom = [...(config.endpoints?.custom ?? []), ...endpoints];
  const raw = config.config ?? {};
  return {
    ...config,
    endpoints: { ...config.endpoints, custom },
    config: {
      ...raw,
      endpoints: { ...raw.endpoints, custom: [...(raw.endpoints?.custom ?? []), ...endpoints] },
    },
  } as AppConfig;
}
