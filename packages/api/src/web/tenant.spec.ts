import { createSearchRun, getSearchPageLimit, withSearchCredentials, withTenantId } from './tenant';

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

describe('withSearchCredentials', () => {
  const key =
    'secret:{{LIBRECHAT_TENANT_ID}};run={{LIBRECHAT_SEARCH_RUN}};pages={{LIBRECHAT_SEARCH_PAGES}}';

  it('fills the tenant, the run id and the page limit into keys and nested options', () => {
    const run = { id: 'a'.repeat(22), pages: 3 };
    const values = { searxngApiKey: key, keenableScraperOptions: { apiKey: key } };

    expect(withSearchCredentials(values, { tenantId: 'tenant-a', run })).toEqual({
      searxngApiKey: `secret:tenant-a;run=${run.id};pages=3`,
      keenableScraperOptions: { apiKey: `secret:tenant-a;run=${run.id};pages=3` },
    });
  });

  it('keeps the run placeholders without a valid run', () => {
    const values = { key };

    expect(withSearchCredentials(values, { tenantId: 'tenant-a' }).key).toBe(
      'secret:tenant-a;run={{LIBRECHAT_SEARCH_RUN}};pages={{LIBRECHAT_SEARCH_PAGES}}',
    );
    expect(withSearchCredentials(values, { run: { id: 'short', pages: 3 } })).toBe(values);
    expect(withSearchCredentials(values, { run: { id: 'a'.repeat(22), pages: -1 } })).toBe(values);
  });
});

describe('createSearchRun', () => {
  it('gives each run its own id that fills the placeholder', () => {
    const one = createSearchRun({ operatorCap: 4, configured: 2 });
    const two = createSearchRun();

    expect(one.pages).toBe(2);
    expect(two.pages).toBe(5);
    expect(one.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(one.id).not.toBe(two.id);
    expect(withSearchCredentials({ k: '{{LIBRECHAT_SEARCH_RUN}}' }, { run: one }).k).toBe(one.id);
  });
});

describe('getSearchPageLimit', () => {
  it("is the operator's cap, lowered by the configured value, 5 without either", () => {
    expect(getSearchPageLimit(undefined, undefined)).toBe(5);
    expect(getSearchPageLimit(3, undefined)).toBe(3);
    expect(getSearchPageLimit(3, 1)).toBe(1);
    expect(getSearchPageLimit(3, 0)).toBe(0);
    expect(getSearchPageLimit(3, 8)).toBe(3);
    expect(getSearchPageLimit(undefined, 2)).toBe(2);
  });

  it('ignores values that are not page counts', () => {
    expect(getSearchPageLimit(-1, 2.5)).toBe(5);
    expect(getSearchPageLimit('3', '1')).toBe(5);
  });
});
