import { withTenantId } from './tenant';

describe('withTenantId', () => {
  it('fills the tenant into every string that names it and leaves the rest', () => {
    const values = { key: 'secret:{{LIBRECHAT_TENANT_ID}}', url: 'http://gw', timeout: 5 };

    expect(withTenantId(values, 'tenant-a')).toEqual({
      key: 'secret:tenant-a',
      url: 'http://gw',
      timeout: 5,
    });
    expect(values.key).toBe('secret:{{LIBRECHAT_TENANT_ID}}');
  });

  it('fills the tenant into nested options such as a scraper key, leaving arrays alone', () => {
    const values = {
      keenableScraperOptions: { apiKey: 'k:{{LIBRECHAT_TENANT_ID}}', timeout: 3 },
      list: ['{{LIBRECHAT_TENANT_ID}}'],
    };

    expect(withTenantId(values, 'tenant-a')).toEqual({
      keenableScraperOptions: { apiKey: 'k:tenant-a', timeout: 3 },
      list: ['{{LIBRECHAT_TENANT_ID}}'],
    });
  });

  it('keeps the placeholder without a tenant or with one that is not a plain id', () => {
    const values = { key: 'secret:{{LIBRECHAT_TENANT_ID}}' };

    expect(withTenantId(values, undefined)).toEqual(values);
    expect(withTenantId(values, 'a:b')).toEqual(values);
    expect(withTenantId(values, '../x')).toEqual(values);
  });
});
