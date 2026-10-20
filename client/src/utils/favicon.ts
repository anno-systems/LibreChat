const ICON_SELECTOR = 'link[rel="icon"], link[rel="apple-touch-icon"]';

/**
 * Points every declared icon at a tenant's favicon (fork-only, `interface.branding.favicon`),
 * or back at the shell's own icons when the tenant has none. The unseen badge paints over
 * `data-original-href`, so that moves too and the badge lands on the tenant's icon.
 */
export function setBrandFavicon(href?: string) {
  for (const link of document.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR)) {
    link.dataset.shellHref ??= link.getAttribute('href') ?? '';
    const next = new URL(href || link.dataset.shellHref, document.baseURI).href;
    if ((link.dataset.originalHref ?? link.href) === next) {
      continue;
    }
    /* The shell declares PNGs; a tenant icon may be another type. */
    link.removeAttribute('type');
    link.href = next;
    link.dataset.originalHref = next;
  }
}
