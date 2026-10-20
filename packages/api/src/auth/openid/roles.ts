/**
 * The role names in an IdP role claim: an array of names, a space- or comma-separated string, or
 * an object keyed by role name, the shape Zitadel uses for `urn:zitadel:iam:org:project:roles`
 * (fork: tenant-aware OpenID).
 */
export function getRoleClaimValues(claim: unknown): string[] {
  if (Array.isArray(claim)) {
    return claim.filter((role): role is string => typeof role === 'string');
  }
  if (typeof claim === 'string') {
    return claim.split(/[\s,]+/).filter(Boolean);
  }
  if (claim && typeof claim === 'object') {
    return Object.keys(claim);
  }
  return [];
}
