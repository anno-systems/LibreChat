/**
 * Login hint passthrough (fork-only). A link that starts the OpenID login with
 * `?login_hint=<login name>` (the admin app's "Open chat" for a tenant's test account) has the
 * identity provider's sign-in page prefilled. Only a plain login name or address is forwarded;
 * anything else is dropped and the login starts as without a hint.
 */

/** RFC 5321's longest address, which bounds any login name the provider accepts. */
const MAX_LENGTH = 254;
/** Letters, digits and the punctuation of addresses and user names; no spaces or controls. */
const LOGIN_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._%+@'-]*$/u;

/** The query's `login_hint` when it is one plain login name, else undefined. */
export function getLoginHint(query: unknown): string | undefined {
  if (!query || typeof query !== 'object') return undefined;
  const value = (query as { login_hint?: unknown }).login_hint;
  if (typeof value !== 'string') return undefined;
  const hint = value.trim();
  if (!hint || hint.length > MAX_LENGTH || !LOGIN_NAME.test(hint)) return undefined;
  return hint;
}

/** Sets `login_hint` on the authorization request's parameters from the login start's query. */
export function applyLoginHint(params: URLSearchParams, query: unknown): void {
  const hint = getLoginHint(query);
  if (hint) params.set('login_hint', hint);
}
