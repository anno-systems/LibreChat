import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { isEnabled } from '~/utils';

/**
 * Custom domains (fork-only). A tenant can be served on its own host, e.g. `https://chat.acme.com`,
 * next to its template host (`TENANT_DOMAIN_CLIENT`). The trusted reverse proxy, which knows
 * which host belongs to which tenant, then sends the public origin of the request in
 * `X-Tenant-Origin` with `X-Tenant-Id`; for that request the tenant's client and server URLs
 * (OpenID callback, redirects, `serverDomain`) are that origin instead of the template's.
 *
 * Only with `TRUST_TENANT_HEADER=true`: the proxy must strip any client-supplied value.
 */

const originStorage = new AsyncLocalStorage<string>();

/** The origin when `value` is exactly an http(s) origin, nothing more; undefined otherwise. */
export function parseTenantOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin === value.replace(/\/$/, '') ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function tenantOriginMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const origin = isEnabled(process.env.TRUST_TENANT_HEADER)
    ? parseTenantOrigin(req.headers['x-tenant-origin'])
    : undefined;
  if (!origin) {
    next();
    return;
  }
  originStorage.run(origin, next);
}

/** The custom-domain origin of the current request, if the proxy named one. */
export function getTenantOrigin(): string | undefined {
  return originStorage.getStore();
}
