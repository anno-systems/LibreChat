import type { TInterfaceConfig, TStartupConfig } from 'librechat-data-provider';

type BrandedFields = Pick<Partial<TStartupConfig>, 'appTitle' | 'customFooter'>;

/**
 * The startup-config fields a tenant's `interface.branding` replaces (fork-only): its name in
 * place of `APP_TITLE` and, for signed-in callers only like `CUSTOM_FOOTER`, its footer.
 * Spread after the env-derived fields; returns nothing for a field the branding leaves unset.
 */
export function brandedStartupFields(
  interfaceConfig: Partial<TInterfaceConfig> | undefined,
  options: { signedIn: boolean },
): BrandedFields {
  const branding = interfaceConfig?.branding;
  if (!branding) {
    return {};
  }
  return {
    ...(branding.appTitle && { appTitle: branding.appTitle }),
    ...(options.signedIn && branding.footer != null && { customFooter: branding.footer }),
  };
}
