import { rejectTenantHeader } from '~/middleware/tenantHeader';

/** Replaced by the request's tenant id in the `TENANT_DOMAIN_*` and `OPENID_TENANT_SCOPE` templates. */
export const TENANT_ID_PLACEHOLDER = '{tenantid}';

/**
 * Deployment settings for serving several tenants from one deployment through one OpenID
 * provider. All fields are optional; when the tenant fields are unset, the helpers below return
 * the single-tenant values (`DOMAIN_CLIENT`, `DOMAIN_SERVER`, `OPENID_SCOPE`) unchanged.
 */
export interface TenantOpenIdSettings {
  DOMAIN_CLIENT?: string;
  DOMAIN_SERVER?: string;
  /** Public client URL per tenant, e.g. `https://{tenantid}.example.com`. */
  TENANT_DOMAIN_CLIENT?: string;
  /** Public server URL per tenant, used for the OpenID callback. */
  TENANT_DOMAIN_SERVER?: string;
  /** Scopes added to `OPENID_SCOPE` for a tenant, e.g. `urn:zitadel:iam:org:id:{tenantid}`. */
  OPENID_TENANT_SCOPE?: string;
  /** ID token claim that must equal the request's tenant id for a login to succeed. */
  OPENID_TENANT_CLAIM?: string;
}

export interface TenantDomains {
  client?: string;
  server?: string;
}

export type TenantClaimCheck =
  | { ok: true }
  | { ok: false; error: { code: 'tenant_missing' | 'tenant_claim_missing' | 'tenant_mismatch' } };

/** Fills a template with the tenant id; undefined when there is no template or no valid tenant. */
function fillTemplate(
  template: string | undefined,
  tenantId: string | undefined,
): string | undefined {
  if (!template || !tenantId || rejectTenantHeader(tenantId)) {
    return undefined;
  }
  return template.split(TENANT_ID_PLACEHOLDER).join(tenantId);
}

/** Public client and server URLs for the request's tenant, falling back to the deployment URLs. */
export function getTenantDomains(
  tenantId: string | undefined,
  settings: TenantOpenIdSettings,
): TenantDomains {
  return {
    client: fillTemplate(settings.TENANT_DOMAIN_CLIENT, tenantId) ?? settings.DOMAIN_CLIENT,
    server: fillTemplate(settings.TENANT_DOMAIN_SERVER, tenantId) ?? settings.DOMAIN_SERVER,
  };
}

/** `baseScope` plus the tenant's scopes, or `baseScope` alone when no tenant scope applies. */
export function getTenantOpenIdScope(
  baseScope: string | undefined,
  tenantId: string | undefined,
  settings: TenantOpenIdSettings,
): string | undefined {
  const tenantScope = fillTemplate(settings.OPENID_TENANT_SCOPE, tenantId);
  if (!tenantScope) {
    return baseScope;
  }
  return [baseScope, tenantScope].filter(Boolean).join(' ');
}

/**
 * Checks that an OpenID login belongs to the tenant it arrived through. Passes when no tenant
 * claim is configured; otherwise fails closed when the tenant or the claim is missing.
 */
export function checkOpenIdTenantClaim(
  claims: Record<string, unknown> | undefined,
  tenantId: string | undefined,
  settings: TenantOpenIdSettings,
): TenantClaimCheck {
  const claimName = settings.OPENID_TENANT_CLAIM;
  if (!claimName) {
    return { ok: true };
  }
  if (!tenantId) {
    return { ok: false, error: { code: 'tenant_missing' } };
  }
  const value = claims?.[claimName];
  if (typeof value !== 'string' || value === '') {
    return { ok: false, error: { code: 'tenant_claim_missing' } };
  }
  if (value !== tenantId) {
    return { ok: false, error: { code: 'tenant_mismatch' } };
  }
  return { ok: true };
}
