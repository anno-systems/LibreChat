import { modelLabelOf } from 'librechat-data-provider';
import type { AppConfig, ModelRef, PlatformProvider } from '@librechat/data-schemas';

/**
 * The display name of a model at migration time (fork-only): the label of a model spec that
 * runs it, else the endpoint's model label (`modelLabels`, which catalog models fill), from the
 * tenant's config for a tenant migration and the base config otherwise, else the platform
 * provider's model label or the name derived from its id. Stored on the redirect and on each notice, so a notice still names a
 * model that has left the catalog and no client has to resolve it.
 */
export function createModelLabelLookup(deps: {
  getConfig(tenantId?: string): Promise<AppConfig>;
  findPlatformProviders?(names: string[]): Promise<Pick<PlatformProvider, 'models'>[]>;
}): (ref: ModelRef, tenantId?: string) => Promise<string | undefined> {
  return async (ref, tenantId) => {
    const config = await deps.getConfig(tenantId);
    const spec = (config.modelSpecs?.list ?? []).find(
      (s) => s.preset?.endpoint === ref.endpoint && s.preset?.model === ref.model && s.label,
    );
    if (spec?.label) return spec.label;
    const endpoint = (config.endpoints?.custom ?? []).find((e) => e.name === ref.endpoint) as
      | { modelLabels?: Record<string, string> }
      | undefined;
    const label = endpoint?.modelLabels?.[ref.model];
    if (label) return label;
    const [provider] = (await deps.findPlatformProviders?.([ref.endpoint])) ?? [];
    const model = provider?.models.find((m) => m.id === ref.model);
    return model ? modelLabelOf(model) : undefined;
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
