import { logger, tenantStorage } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Group sync at OpenID sign-in (fork-only). With `OPENID_GROUPS_CLAIM` set, the user's
 * memberships in their identity provider's groups are made to match the groups the token names,
 * so config overrides and sharing per group follow the customer's directory. Unset, nothing
 * changes.
 *
 * The claim may hold:
 * - an array of group ids (a provider's own `groups` claim); the groups belong to the token's
 *   issuer, or to `OPENID_GROUPS_SCOPE` when set;
 * - an object `{ idp, groups }`, or that object as base64 JSON, which is how a broker passes on
 *   the groups of the provider the user came from (Zitadel user metadata, see the admin app's
 *   identity provider hook). Groups then belong to that provider.
 *
 * The claim path is split at dots, so `urn:zitadel:iam:user:metadata.idp_groups` reads the key
 * `idp_groups` of the claim `urn:zitadel:iam:user:metadata`.
 */

export interface OpenIdGroupSettings {
  OPENID_GROUPS_CLAIM?: string;
  OPENID_GROUPS_SCOPE?: string;
}

export interface OpenIdGroups {
  /** Whose groups these are; another provider's groups of the tenant are left alone. */
  scope: string;
  groups: { id: string }[];
}

/** Longest group id taken from a token; longer values are not group ids. */
const MAX_GROUP_ID_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function claimAt(claims: Record<string, unknown>, path: string): unknown {
  let value: unknown = claims;
  for (const key of path.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

function decodeBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function groupIds(value: unknown): { id: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(
    (g): g is string => typeof g === 'string' && g.length > 0 && g.length <= MAX_GROUP_ID_LENGTH,
  );
  return [...new Set(ids)].map((id) => ({ id }));
}

/**
 * The groups the token names, or null when the claim is not configured, absent or malformed.
 * Null means "unknown", so memberships stay as they are; an empty list means "no groups".
 */
export function openIdGroupsOf(
  claims: Record<string, unknown>,
  env: OpenIdGroupSettings,
): OpenIdGroups | null {
  const path = env.OPENID_GROUPS_CLAIM?.trim();
  if (!path) return null;
  let value = claimAt(claims, path);
  if (typeof value === 'string') value = decodeBase64Json(value);

  const direct = groupIds(value);
  if (direct) {
    const scope =
      env.OPENID_GROUPS_SCOPE?.trim() || (typeof claims.iss === 'string' ? claims.iss : '');
    return scope ? { scope, groups: direct } : null;
  }
  if (isRecord(value) && typeof value.idp === 'string' && value.idp) {
    const groups = groupIds(value.groups);
    return groups ? { scope: value.idp, groups } : null;
  }
  return null;
}

export interface OpenIdGroupSyncDeps {
  syncExternalGroupMemberships(params: {
    userId: string;
    scope: string;
    groups: { id: string }[];
  }): Promise<{ joined: number; left: number }>;
}

/**
 * Syncs the signed-in user's provider groups in the user's tenant. A failure is logged and the
 * sign-in goes on with the memberships of the last successful sync.
 */
export async function syncOpenIdGroups(
  deps: OpenIdGroupSyncDeps,
  user: { _id: unknown; tenantId?: string },
  claims: Record<string, unknown>,
  env: OpenIdGroupSettings,
): Promise<void> {
  const found = openIdGroupsOf(claims, env);
  if (!found) return;
  const userId = String(user._id);
  const run = () => deps.syncExternalGroupMemberships({ userId, ...found });
  try {
    const result = user.tenantId
      ? await tenantStorage.run({ tenantId: user.tenantId }, run)
      : await run();
    if (result.joined > 0 || result.left > 0) {
      logger.info(
        `[openidGroups] user ${userId}: joined ${result.joined}, left ${result.left} group(s)`,
      );
    }
  } catch (error) {
    logger.error('[openidGroups] group sync failed', getSafeErrorMetadata(error));
  }
}
