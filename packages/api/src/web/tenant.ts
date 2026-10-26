/**
 * The request's tenant in web search credentials (fork-only). A deployment that meters one search
 * account per tenant, such as the platform's search gateway, writes `{{LIBRECHAT_TENANT_ID}}` into
 * a key or URL (`SEARCH_GATEWAY_KEY=<secret>:{{LIBRECHAT_TENANT_ID}}`) and receives each request
 * with the caller's tenant in its place, so no tenant needs keys of its own. Without a tenant, or
 * with one that is not a plain id, the placeholder stays and the service refuses the request.
 */
export const TENANT_PLACEHOLDER = '{{LIBRECHAT_TENANT_ID}}';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fill(values: Record<string, unknown>, tenantId: string): Record<string, unknown> {
  const entries = Object.entries(values).map(([key, value]) => {
    if (typeof value === 'string') {
      return [key, value.replaceAll(TENANT_PLACEHOLDER, tenantId)];
    }
    /** Nested options carry keys too (`keenableScraperOptions.apiKey`). */
    return [key, isPlainObject(value) ? fill(value, tenantId) : value];
  });
  return Object.fromEntries(entries);
}

export function withTenantId<T extends object>(values: T, tenantId: string | undefined): T {
  if (!tenantId || !TENANT_ID.test(tenantId)) {
    return values;
  }
  return fill(values as Record<string, unknown>, tenantId) as T;
}
