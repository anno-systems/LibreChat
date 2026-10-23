import type { ConfigOverrideIssue } from '@librechat/data-schemas';
import { collectErrors } from '~/app/theme';

/** Stable code of a theme the client would refuse to paint. */
export const THEME_INVALID = 'theme_invalid';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The whole theme a write sets, from `interface.theme` or an `interface` section. */
function themeOf(fields: Record<string, unknown>): unknown {
  if ('interface.theme' in fields) return fields['interface.theme'];
  const ui = fields.interface;
  return isRecord(ui) ? ui.theme : undefined;
}

/**
 * The reasons an admin config write's theme cannot be painted, checked with the rules the server
 * applies when it loads the config (fork). Without this, such a theme is stored and then silently
 * dropped at load, so the admin never learns why the look did not change. Only a whole theme is
 * checked; a write of one field inside it is checked when the config loads, as before.
 */
export function getThemeWriteIssues(fields: Record<string, unknown>): ConfigOverrideIssue[] {
  const theme = themeOf(fields);
  if (theme == null) return [];
  return collectErrors(theme).map(({ path }) => {
    const segments = ['interface', 'theme', ...path];
    return { path: segments.join('.'), segments, code: THEME_INVALID };
  });
}
