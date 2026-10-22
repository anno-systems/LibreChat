import { getTenantId, tenantStorage } from '@librechat/data-schemas';
import {
  runInHeaderTenant,
  withHeaderTenant,
  getTenantDomains,
  getAdminPanelLink,
  getTenantOpenIdScope,
  checkOpenIdTenantClaim,
} from './tenant';

const single = {
  DOMAIN_CLIENT: 'https://chat.example.com',
  DOMAIN_SERVER: 'https://api.example.com',
};

const multi = {
  ...single,
  TENANT_DOMAIN_CLIENT: 'https://{tenantid}.example.com',
  TENANT_DOMAIN_SERVER: 'https://{tenantid}.example.com',
  OPENID_TENANT_SCOPE: 'urn:zitadel:iam:org:id:{tenantid} urn:zitadel:iam:user:resourceowner',
  OPENID_TENANT_CLAIM: 'urn:zitadel:iam:user:resourceowner:id',
};

describe('getTenantDomains', () => {
  it('keeps the deployment URLs when no tenant templates are set', () => {
    expect(getTenantDomains('acme', single)).toEqual({
      client: 'https://chat.example.com',
      server: 'https://api.example.com',
    });
  });

  it('fills the templates with the tenant id', () => {
    expect(getTenantDomains('acme', multi)).toEqual({
      client: 'https://acme.example.com',
      server: 'https://acme.example.com',
    });
  });

  it('falls back to the deployment URLs without a tenant', () => {
    expect(getTenantDomains(undefined, multi)).toEqual({
      client: 'https://chat.example.com',
      server: 'https://api.example.com',
    });
  });

  it('never templates the system tenant or a malformed id', () => {
    expect(getTenantDomains('__SYSTEM__', multi).client).toBe('https://chat.example.com');
    expect(getTenantDomains('evil.com/x', multi).client).toBe('https://chat.example.com');
  });
});

describe('getAdminPanelLink', () => {
  it("names the user's tenant in the admin panel link", () => {
    expect(getAdminPanelLink('https://admin.example.com', 'tenant-a')).toBe(
      'https://admin.example.com/?tenant=tenant-a',
    );
    expect(getAdminPanelLink('https://admin.example.com/panel?x=1', 'acme')).toBe(
      'https://admin.example.com/panel?x=1&tenant=acme',
    );
  });

  it('leaves the link as it is without a valid tenant', () => {
    expect(getAdminPanelLink('https://admin.example.com', undefined)).toBe(
      'https://admin.example.com',
    );
    expect(getAdminPanelLink('https://admin.example.com', '__SYSTEM__')).toBe(
      'https://admin.example.com',
    );
    expect(getAdminPanelLink('not a url', 'tenant-a')).toBe('not a url');
  });
});

describe('getTenantOpenIdScope', () => {
  it('returns the base scope when no tenant scope is configured', () => {
    expect(getTenantOpenIdScope('openid profile email', 'acme', single)).toBe(
      'openid profile email',
    );
  });

  it('appends the tenant scopes', () => {
    expect(getTenantOpenIdScope('openid profile email', 'acme', multi)).toBe(
      'openid profile email urn:zitadel:iam:org:id:acme urn:zitadel:iam:user:resourceowner',
    );
  });

  it('returns the base scope without a tenant', () => {
    expect(getTenantOpenIdScope('openid', undefined, multi)).toBe('openid');
  });
});

describe('checkOpenIdTenantClaim', () => {
  const claim = multi.OPENID_TENANT_CLAIM;

  it('passes when no tenant claim is configured', () => {
    expect(checkOpenIdTenantClaim({}, undefined, single)).toEqual({ ok: true });
  });

  it('passes when the claim equals the tenant', () => {
    expect(checkOpenIdTenantClaim({ [claim]: 'acme' }, 'acme', multi)).toEqual({ ok: true });
  });

  it('rejects a login from another tenant', () => {
    expect(checkOpenIdTenantClaim({ [claim]: 'other' }, 'acme', multi)).toEqual({
      ok: false,
      error: { code: 'tenant_mismatch' },
    });
  });

  it('fails closed when the claim is missing or not a string', () => {
    expect(checkOpenIdTenantClaim({}, 'acme', multi)).toEqual({
      ok: false,
      error: { code: 'tenant_claim_missing' },
    });
    expect(checkOpenIdTenantClaim({ [claim]: ['acme'] }, 'acme', multi)).toEqual({
      ok: false,
      error: { code: 'tenant_claim_missing' },
    });
  });

  it('fails closed without a tenant', () => {
    expect(checkOpenIdTenantClaim({ [claim]: 'acme' }, undefined, multi)).toEqual({
      ok: false,
      error: { code: 'tenant_missing' },
    });
  });
});

describe('runInHeaderTenant', () => {
  const previous = process.env.TRUST_TENANT_HEADER;
  const headers = { 'x-tenant-id': 'acme' };

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.TRUST_TENANT_HEADER;
    } else {
      process.env.TRUST_TENANT_HEADER = previous;
    }
  });

  it("runs in the trusted header's tenant and keeps the request context", async () => {
    process.env.TRUST_TENANT_HEADER = 'true';

    const seen = await tenantStorage.run({ requestId: 'req-1' }, () =>
      runInHeaderTenant(headers, async () => tenantStorage.getStore()),
    );

    expect(seen).toEqual({ requestId: 'req-1', tenantId: 'acme' });
  });

  it('ignores the header unless TRUST_TENANT_HEADER is on', async () => {
    delete process.env.TRUST_TENANT_HEADER;

    expect(await runInHeaderTenant(headers, async () => getTenantId())).toBeUndefined();
  });

  it('never replaces a tenant that is already set', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';

    const seen = await tenantStorage.run({ tenantId: 'own' }, () =>
      runInHeaderTenant(headers, async () => getTenantId()),
    );

    expect(seen).toBe('own');
  });

  it('rejects the system sentinel and malformed values', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';

    for (const value of ['__SYSTEM__', 'a b', '']) {
      expect(await runInHeaderTenant({ 'x-tenant-id': value }, async () => getTenantId())).toBe(
        undefined,
      );
    }
  });

  it('wraps a verify callback that takes the request first', async () => {
    process.env.TRUST_TENANT_HEADER = 'true';
    const verify = withHeaderTenant(async (_req, payload: string) => `${getTenantId()}:${payload}`);

    expect(await verify({ headers }, 'sub-1')).toBe('acme:sub-1');
  });
});
