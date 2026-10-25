import { getTenantId, tenantStorage } from '@librechat/data-schemas';
import type { IncomingHttpHeaders } from 'http';
import { rejectTenantHeader } from '~/middleware/tenantHeader';
import { getTenantOrigin } from '~/middleware/tenantOrigin';
import { isEnabled } from '~/utils';

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
  /** Where the provider sends the browser after its logout; may contain `{tenantid}`. */
  OPENID_POST_LOGOUT_REDIRECT_URI?: string;
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

/**
 * Public client and server URLs for the request's tenant, falling back to the deployment URLs.
 * A request on one of the tenant's custom domains uses that domain's origin (`X-Tenant-Origin`
 * from the trusted proxy, see `middleware/tenantOrigin.ts`).
 */
export function getTenantDomains(
  tenantId: string | undefined,
  settings: TenantOpenIdSettings,
): TenantDomains {
  const origin = tenantId ? getTenantOrigin() : undefined;
  if (origin) {
    return { client: origin, server: origin };
  }
  return {
    client: fillTemplate(settings.TENANT_DOMAIN_CLIENT, tenantId) ?? settings.DOMAIN_CLIENT,
    server: fillTemplate(settings.TENANT_DOMAIN_SERVER, tenantId) ?? settings.DOMAIN_SERVER,
  };
}

/**
 * Where the OpenID provider sends the browser after RP-initiated logout: the configured
 * `OPENID_POST_LOGOUT_REDIRECT_URI` (with `{tenantid}` filled in), else the tenant's own login
 * page, so a user who signs out on their tenant's host lands back there and not on the
 * deployment's `DOMAIN_CLIENT`. Each value must be a post-logout redirect URI of the OpenID
 * client.
 */
export function getTenantPostLogoutRedirectUri(
  tenantId: string | undefined,
  settings: TenantOpenIdSettings,
): string {
  const configured = settings.OPENID_POST_LOGOUT_REDIRECT_URI;
  if (configured) {
    return configured.includes(TENANT_ID_PLACEHOLDER)
      ? (fillTemplate(configured, tenantId) ?? `${settings.DOMAIN_CLIENT}/login`)
      : configured;
  }
  return `${getTenantDomains(tenantId, settings).client}/login`;
}

/**
 * The admin panel link shown in the user's settings, naming their tenant (`?tenant=`), so the
 * admin panel can fill in the organization at its sign-in. The link opens without a referrer,
 * so the tenant cannot be read from where the admin came from.
 */
export function getAdminPanelLink(adminPanelUrl: string, tenantId: string | undefined): string {
  if (!tenantId || rejectTenantHeader(tenantId)) {
    return adminPanelUrl;
  }
  try {
    const url = new URL(adminPanelUrl);
    url.searchParams.set('tenant', tenantId);
    return url.toString();
  } catch {
    return adminPanelUrl;
  }
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

/**
 * Runs `fn` in the tenant the trusted reverse proxy named (`X-Tenant-Id`) when no tenant context
 * is set yet. Authenticated routes take their tenant from the user record after authentication,
 * so a bearer strategy that finds the user by its OpenID identity (`openidJwt` with
 * `OPENID_REUSE_TOKENS`) would otherwise query without a tenant, which strict isolation rejects.
 * Without header trust, without a valid header, or inside an existing tenant, `fn` runs as is.
 */
export function runInHeaderTenant<T>(
  headers: IncomingHttpHeaders,
  fn: () => Promise<T>,
): Promise<T> {
  if (getTenantId() || !isEnabled(process.env.TRUST_TENANT_HEADER)) {
    return fn();
  }
  const raw = headers['x-tenant-id'];
  const tenantId = typeof raw === 'string' ? raw.trim() : '';
  if (!tenantId || rejectTenantHeader(tenantId)) {
    return fn();
  }
  return tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, fn);
}

/** Wraps a passport verify callback that receives the request first in `runInHeaderTenant`. */
export function withHeaderTenant<A extends unknown[], T>(
  verify: (req: { headers: IncomingHttpHeaders }, ...args: A) => Promise<T>,
): (req: { headers: IncomingHttpHeaders }, ...args: A) => Promise<T> {
  return (req, ...args) => runInHeaderTenant(req.headers, () => verify(req, ...args));
}
