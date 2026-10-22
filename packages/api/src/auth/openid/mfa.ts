/**
 * A second factor for the admin login (fork-only). With `OPENID_ADMIN_REQUIRE_MFA=true` the admin
 * panel login is accepted only when the identity provider reports a second factor in the ID
 * token's `amr` claim (RFC 8176); the user login is not affected. Unset, behaviour is upstream's.
 */

/** Authentication methods that prove a second factor (RFC 8176, and Zitadel's names). */
const SECOND_FACTORS = new Set(['mfa', 'otp', 'u2f', 'hwk', 'swk', 'passkey', 'sms', 'fido']);

/** The code the admin panel receives for a login refused for lack of a second factor. */
export const ADMIN_MFA_REQUIRED = 'mfa_required';

export function requiresAdminMfa(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPENID_ADMIN_REQUIRE_MFA?.trim().toLowerCase() === 'true';
}

/** Whether the token's claims name a second factor. */
export function hasSecondFactor(claims: Record<string, unknown> | undefined): boolean {
  const amr = claims?.amr;
  return Array.isArray(amr) && amr.some((method) => SECOND_FACTORS.has(String(method)));
}

/**
 * Where a refused admin login returns to: the admin panel's callback with a stable code,
 * `mfa_required` when a second factor was missing and `auth_failed` for anything else.
 */
export function adminLoginFailureUrl(callbackUrl: string, message: unknown): string {
  const url = new URL(callbackUrl);
  const mfa = message === ADMIN_MFA_REQUIRED;
  url.searchParams.set('error', mfa ? ADMIN_MFA_REQUIRED : 'auth_failed');
  url.searchParams.set(
    'error_description',
    mfa ? 'A second factor is required' : 'Authentication failed',
  );
  return url.toString();
}
