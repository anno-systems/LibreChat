import { escapeHtmlAttribute } from '~/security/html';

/** The deployment's name and description, as the server holds them at startup. */
export interface ShellTitleSource {
  /** `interface.branding.appTitle` of the base config, else `APP_TITLE`. */
  title?: string | null;
  /** `interface.branding.description` of the base config. */
  description?: string | null;
}

const TITLE = /<title>[^<]*<\/title>/;
const DESCRIPTION = /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/;

/**
 * Names the deployment in the HTML shell (fork-only): the `<title>`, the description and Open
 * Graph tags, which link previews in messengers and search results read without running the app.
 * Without a title the shell stays upstream's; with a title but no description, the title stands
 * in for upstream's description, which names LibreChat.
 *
 * One shell serves every request, so a tenant's own branding shows once the app has loaded
 * (`/api/config`), not in a preview.
 */
export function injectShellTitle(html: string, source?: ShellTitleSource | null): string {
  const title = source?.title?.trim();
  if (!title) {
    return html;
  }
  const description = source?.description?.trim() || title;
  const name = escapeHtmlAttribute(title);
  const text = escapeHtmlAttribute(description);
  const tags =
    `<meta name="description" content="${text}" />` +
    `<meta property="og:type" content="website" />` +
    `<meta property="og:site_name" content="${name}" />` +
    `<meta property="og:title" content="${name}" />` +
    `<meta property="og:description" content="${text}" />`;
  const titled = html.replace(TITLE, () => `<title>${name}</title>`);
  return DESCRIPTION.test(titled)
    ? titled.replace(DESCRIPTION, () => tags)
    : titled.replace('</head>', () => `${tags}</head>`);
}
