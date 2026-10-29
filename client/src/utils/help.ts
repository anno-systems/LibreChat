/** The help URL upstream's server sends when the deployment sets no `HELP_AND_FAQ_URL`. */
const UPSTREAM_HELP_URLS = new Set(['https://librechat.ai', 'https://www.librechat.ai']);

/**
 * A section of the deployment's own help (fork-only): `helpAndFaqURL` with `#anchor`, replacing any
 * fragment it carries. Without a configured help URL (unset, hidden with "/", or upstream's
 * default) it is `fallback`, upstream's documentation link.
 */
export function getHelpLink(
  helpAndFaqURL: string | undefined,
  anchor: string,
  fallback: string,
): string {
  const base = helpAndFaqURL?.trim().split('#')[0] ?? '';
  if (!base || base === '/' || UPSTREAM_HELP_URLS.has(base.replace(/\/+$/, ''))) {
    return fallback;
  }
  return `${base}#${anchor}`;
}
