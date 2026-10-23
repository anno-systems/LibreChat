/**
 * The request's tenant in web search credentials (fork-only). A deployment that meters one search
 * account per tenant, such as the platform's search gateway, writes `{{LIBRECHAT_TENANT_ID}}` into
 * a key or URL (`SEARCH_GATEWAY_KEY=<secret>:{{LIBRECHAT_TENANT_ID}}`) and receives each request
 * with the caller's tenant in its place, so no tenant needs keys of its own. Without a tenant, or
 * with one that is not a plain id, the placeholder stays and the service refuses the request.
 */
export const TENANT_PLACEHOLDER = '{{LIBRECHAT_TENANT_ID}}';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function withTenantId<T extends object>(values: T, tenantId: string | undefined): T {
  if (!tenantId || !TENANT_ID.test(tenantId)) {
    return values;
  }
  const entries = Object.entries(values).map(([key, value]) => [
    key,
    typeof value === 'string' ? value.replaceAll(TENANT_PLACEHOLDER, tenantId) : value,
  ]);
  return Object.fromEntries(entries) as T;
}
