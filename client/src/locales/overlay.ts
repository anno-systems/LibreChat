import type { TranslationResource } from './i18n';

type LocaleModule = { default: TranslationResource };

/**
 * Merges a fork-only translation file over upstream's locale file (fork: German overlay). The
 * fork's strings live in their own file, such as `de/fork.json`, so upstream's `translation.json`
 * stays untouched and upstream syncs never conflict on it. Overlay keys win.
 */
export async function withOverlay(
  base: Promise<LocaleModule>,
  overlay: Promise<LocaleModule>,
): Promise<LocaleModule> {
  const [baseModule, overlayModule] = await Promise.all([base, overlay]);
  return { default: { ...baseModule.default, ...overlayModule.default } };
}
