/**
 * Login hint passthrough (fork-only). A link that starts the OpenID login with
 * `?login_hint=<login name>` (the admin app's "Open chat" for a tenant's test account) has the
 * identity provider's sign-in page prefilled. Such a link also asks for `prompt=login`, so the
 * provider shows its sign-in page instead of reusing the session of whoever is already signed in
 * there (the operator who opened the test account). Only a plain login name or address is
 * forwarded; anything else is dropped and the login starts as without a hint.
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

/**
 * Sets `login_hint` and `prompt=login` on the authorization request's parameters from the login
 * start's query.
 */
export function applyLoginHint(params: URLSearchParams, query: unknown): void {
  const hint = getLoginHint(query);
  if (!hint) return;
  params.set('login_hint', hint);
  params.set('prompt', 'login');
}

/**
 * Whether a request is a login start that carries only `login_hint`. openid-client's passport
 * strategy treats any GET with query parameters as the provider's callback, so such a start would
 * fail its state check with 401 instead of redirecting to the provider.
 */
export function isHintedLoginStart(method: string | undefined, query: unknown): boolean {
  if (method !== 'GET' || !query || typeof query !== 'object') return false;
  const keys = Object.keys(query);
  return keys.length === 1 && keys[0] === 'login_hint';
}
