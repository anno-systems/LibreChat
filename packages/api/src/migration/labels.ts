import type { AppConfig, ModelRef, PlatformProvider } from '@librechat/data-schemas';

/**
 * The display name of a model at migration time (fork-only): the label of a model spec that
 * runs it, from the tenant's config for a tenant migration and the base config otherwise. Stored
 * on the redirect and on each notice, so a notice still names a model that has left the
 * catalog and no client has to resolve it.
 */
export function createModelLabelLookup(deps: {
  getConfig(tenantId?: string): Promise<AppConfig>;
}): (ref: ModelRef, tenantId?: string) => Promise<string | undefined> {
  return async (ref, tenantId) => {
    const specs = (await deps.getConfig(tenantId)).modelSpecs?.list ?? [];
    const spec = specs.find(
      (s) => s.preset?.endpoint === ref.endpoint && s.preset?.model === ref.model && s.label,
    );
    return spec?.label;
  };
}

/** Whether a platform provider is assigned per tenant rather than offered to all tenants. */
export function createAssignedProviderCheck(deps: {
  findPlatformProviders(names: string[]): Promise<Pick<PlatformProvider, 'allTenants'>[]>;
}): (endpoint: string) => Promise<boolean> {
  return async (endpoint) => {
    const [provider] = await deps.findPlatformProviders([endpoint]);
    return provider != null && provider.allTenants !== true;
  };
}
