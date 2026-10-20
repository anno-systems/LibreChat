import type { NextFunction, Request, Response } from 'express';
import { getTenantOrigin, parseTenantOrigin, tenantOriginMiddleware } from './tenantOrigin';
import { getTenantDomains } from '~/auth/openid/tenant';

const settings = {
  DOMAIN_CLIENT: 'http://localhost:3080',
  DOMAIN_SERVER: 'http://localhost:3080',
  TENANT_DOMAIN_CLIENT: 'https://{tenantid}.example.com',
  TENANT_DOMAIN_SERVER: 'https://{tenantid}.example.com',
};

/** Runs the middleware for a request with the given headers and returns what `next` saw. */
function within<T>(headers: Record<string, string>, read: () => T): T {
  let seen: T | undefined;
  const next: NextFunction = () => {
    seen = read();
  };
  tenantOriginMiddleware({ headers } as unknown as Request, {} as Response, next);
  return seen as T;
}

describe('parseTenantOrigin', () => {
  it('accepts a bare http(s) origin', () => {
    expect(parseTenantOrigin('https://chat.acme.com')).toBe('https://chat.acme.com');
    expect(parseTenantOrigin('http://chat.acme.test:8080/')).toBe('http://chat.acme.test:8080');
  });

  it('refuses paths, other schemes and junk', () => {
    for (const value of [
      'https://chat.acme.com/x',
      'https://chat.acme.com?a=1',
      'javascript:alert(1)',
      'chat.acme.com',
      '',
      undefined,
      ['https://a.com'],
    ]) {
      expect(parseTenantOrigin(value)).toBeUndefined();
    }
  });
});

describe('tenantOriginMiddleware', () => {
  const original = process.env.TRUST_TENANT_HEADER;
  afterEach(() => {
    process.env.TRUST_TENANT_HEADER = original;
  });

  it("serves a custom domain's request on that domain", () => {
    process.env.TRUST_TENANT_HEADER = 'true';

    const domains = within({ 'x-tenant-origin': 'https://chat.acme.com' }, () =>
      getTenantDomains('acme', settings),
    );

    expect(domains).toEqual({ client: 'https://chat.acme.com', server: 'https://chat.acme.com' });
    expect(getTenantOrigin()).toBeUndefined();
  });

  it('keeps the template URLs without the header, without trust and without a tenant', () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    expect(within({}, () => getTenantDomains('acme', settings)).client).toBe(
      'https://acme.example.com',
    );
    expect(
      within({ 'x-tenant-origin': 'https://chat.acme.com' }, () =>
        getTenantDomains(undefined, settings),
      ).client,
    ).toBe('http://localhost:3080');

    process.env.TRUST_TENANT_HEADER = 'false';
    expect(
      within({ 'x-tenant-origin': 'https://chat.acme.com' }, () => getTenantOrigin()),
    ).toBeUndefined();
  });
});
