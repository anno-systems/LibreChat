import type { AppConfig, PlatformProvider, TenantCatalog } from '@librechat/data-schemas';
import type { TEndpoint } from 'librechat-data-provider';

/**
 * Per-tenant model catalog (fork-only). Besides `librechat.yaml`'s custom endpoints, a tenant
 * gets the platform providers the operator assigned to it, limited to the assigned models, and,
 * when the operator opted it in (`byok`), endpoints with its own key. They join the tenant's
 * base config as tenant-scoped custom endpoints (`tenantId`, the same scoping upstream applies
 * to YAML endpoints), so model lists, the catalog lock and chat requests treat them like YAML
 * endpoints. No other tenant ever sees them.
 *
 * The admin config API must run with `ADMIN_CONFIG_CATALOG_LOCK`: without it a tenant admin
 * could override an assigned endpoint's `baseURL` and receive the operator's key.
 */

export interface TenantEndpointLoaderDeps {
  getTenantCatalog(tenantId: string): Promise<TenantCatalog | null>;
  findPlatformProviders(names: string[]): Promise<PlatformProvider[]>;
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

function endpointOf(
  tenantId: string,
  source: { name: string; baseURL: string; apiKey: string; label?: string; dropParams?: string[] },
  models: string[],
): TEndpoint {
  return {
    name: source.name,
    baseURL: source.baseURL,
    apiKey: source.apiKey,
    models: { default: models, fetch: false },
    dropParams: [...(source.dropParams ?? DEFAULT_DROP_PARAMS)],
    modelDisplayLabel: source.label ?? source.name,
    titleConvo: true,
    titleModel: 'current_model',
    tenantId,
  } as TEndpoint;
}

/** The endpoints a tenant's catalog yields, keys decrypted; assignments of unknown providers or no models are skipped. */
export function catalogEndpoints(
  catalog: TenantCatalog | null,
  providers: PlatformProvider[],
  decrypt: (value: string) => string,
): TEndpoint[] {
  if (!catalog) return [];
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const endpoints: TEndpoint[] = [];
  for (const assignment of catalog.providers) {
    const provider = byName.get(assignment.name);
    if (!provider) continue;
    const models = assignment.models.filter((model) => provider.models.includes(model));
    if (models.length === 0) continue;
    endpoints.push(
      endpointOf(catalog.tenantId, { ...provider, apiKey: decrypt(provider.apiKey) }, models),
    );
  }
  if (catalog.byok) {
    for (const own of catalog.own) {
      if (own.models.length === 0) continue;
      endpoints.push(
        endpointOf(catalog.tenantId, { ...own, apiKey: decrypt(own.apiKey) }, own.models),
      );
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
    if (!catalog) return [];
    const providers = await deps.findPlatformProviders(catalog.providers.map((p) => p.name));
    return catalogEndpoints(catalog, providers, deps.decrypt);
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
