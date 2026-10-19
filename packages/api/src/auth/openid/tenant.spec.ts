import { checkOpenIdTenantClaim, getTenantDomains, getTenantOpenIdScope } from './tenant';

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
