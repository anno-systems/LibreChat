import type { AppConfig, PlatformProvider, TenantCatalog } from '@librechat/data-schemas';
import { catalogEndpoints, createTenantEndpointLoader, withTenantEndpoints } from './catalog';
import { createAppConfigService } from '~/app/service';

const decrypt = (value: string) => value.replace(/^enc:/, '');

const provider: PlatformProvider = {
  name: 'Mistral Platform',
  label: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  apiKey: 'enc:operator-key',
  models: [{ id: 'small', label: 'Mistral Small' }, { id: 'medium' }, { id: 'large' }],
};

const catalog: TenantCatalog = {
  tenantId: 'tenant-a',
  byok: true,
  providers: [
    { name: 'Mistral Platform', models: ['small', 'large', 'gone'] },
    { name: 'Deleted', models: ['x'] },
  ],
  own: [
    {
      name: 'Own',
      baseURL: 'https://llm.a.example/v1',
      apiKey: 'enc:tenant-key',
      models: [{ id: 'm', label: 'Mine' }],
    },
  ],
};

describe('catalogEndpoints', () => {
  it('yields assigned providers with their assigned models and the tenant endpoints', () => {
    const endpoints = catalogEndpoints('tenant-a', catalog, [provider], decrypt);

    expect(endpoints).toEqual([
      expect.objectContaining({
        name: 'Mistral Platform',
        apiKey: 'operator-key',
        baseURL: 'https://api.mistral.ai/v1',
        models: { default: ['small', 'large'], fetch: false },
        modelDisplayLabel: 'Mistral',
        tenantId: 'tenant-a',
      }),
      expect.objectContaining({ name: 'Own', apiKey: 'tenant-key', tenantId: 'tenant-a' }),
    ]);
  });

  it("drops `user` unless the endpoint sets its own list, so Mistral's API accepts the request", () => {
    const endpoints = catalogEndpoints(
      'tenant-a',
      {
        ...catalog,
        own: [{ ...catalog.own[0], dropParams: [] }],
      },
      [{ ...provider, dropParams: ['user', 'stop'] }],
      decrypt,
    );
    const [defaulted] = catalogEndpoints('tenant-a', catalog, [provider], decrypt);

    expect(defaulted.dropParams).toEqual(['user']);
    expect(endpoints.map((e) => e.dropParams)).toEqual([['user', 'stop'], []]);
  });

  it("gives each limited model of a platform provider its queue, never a tenant's own", () => {
    const [platform, own] = catalogEndpoints(
      'tenant-a',
      catalog,
      [
        {
          ...provider,
          models: [
            { id: 'small', limits: { concurrency: 2 } },
            { id: 'large', limits: { tokensPerMinute: 1000 } },
            { id: 'medium', limits: { concurrency: 9 } },
          ],
          queue: { maxWaitSeconds: 60 },
        },
      ],
      decrypt,
    );

    /** Only assigned models, each with the provider's queue settings. */
    expect(platform).toEqual(
      expect.objectContaining({
        modelLimits: {
          small: { concurrency: 2, maxWaitSeconds: 60 },
          large: { tokensPerMinute: 1000, maxWaitSeconds: 60 },
        },
      }),
    );
    expect(platform).not.toHaveProperty('limits');
    expect(own).not.toHaveProperty('modelLimits');
  });

  it('leaves models without limits unqueued and names every model, by label or by its id', () => {
    const [platform, own] = catalogEndpoints('tenant-a', catalog, [provider], decrypt);

    expect(platform).not.toHaveProperty('modelLimits');
    expect(platform).toEqual(
      expect.objectContaining({ modelLabels: { small: 'Mistral Small', large: 'Large' } }),
    );
    expect(own).toEqual(expect.objectContaining({ modelLabels: { m: 'Mine' } }));
  });

  it("names each model's vendor and the provider's label and location for the selector", () => {
    const azure: PlatformProvider = {
      name: 'azure-anno-systems-westeurope',
      label: 'Azure',
      apiKey: 'enc:operator-key',
      location: { type: 'global' },
      models: [
        { id: 'mistral-medium-3-5', baseURL: 'https://x.example/openai/v1' },
        { id: 'Mistral-Large-3', label: 'Mistral Large', baseURL: 'https://x.example/openai/v1' },
        { id: 'gpt-6.1-terra', api: 'responses', baseURL: 'https://x.example/openai/v1' },
        {
          id: 'claude-sonnet-5-5',
          api: 'anthropic',
          baseURL: 'https://x.example/anthropic/v1',
          location: { type: 'country', code: 'SE' },
        },
        { id: 'house-model', vendor: 'mistral', baseURL: 'https://x.example/openai/v1' },
        { id: 'phi-4', location: { type: 'global' }, baseURL: 'https://x.example/openai/v1' },
      ],
      allTenants: true,
    };
    const [platform, own] = catalogEndpoints(
      'tenant-a',
      { ...catalog, providers: [], own: [{ ...catalog.own[0], location: { type: 'eu' } }] },
      [azure],
      decrypt,
    );

    expect(platform).toEqual(
      expect.objectContaining({
        modelVendors: {
          'mistral-medium-3-5': 'mistral',
          'Mistral-Large-3': 'mistral',
          'gpt-6.1-terra': 'openai',
          'claude-sonnet-5-5': 'anthropic',
          'house-model': 'mistral',
          'phi-4': 'other',
        },
        modelLabels: {
          'mistral-medium-3-5': 'Mistral Medium 3.5',
          'Mistral-Large-3': 'Mistral Large',
          'gpt-6.1-terra': 'GPT-6.1 Terra',
          'claude-sonnet-5-5': 'Claude Sonnet 5.5',
          'house-model': 'House Model',
          'phi-4': 'Phi 4',
        },
        hosting: { label: 'Azure', location: { type: 'global' } },
        modelLocations: { 'claude-sonnet-5-5': { type: 'country', code: 'SE' } },
        modelDisplayLabel: 'Azure',
      }),
    );
    expect(own).toEqual(
      expect.objectContaining({
        modelVendors: { m: 'other' },
        hosting: { label: 'Own', location: { type: 'eu' } },
      }),
    );
    expect(own).not.toHaveProperty('modelLocations');
  });

  it('leaves out the tenant endpoints without BYOK and assignments without models', () => {
    const endpoints = catalogEndpoints(
      'tenant-a',
      { ...catalog, byok: false, providers: [{ name: 'Mistral Platform', models: ['gone'] }] },
      [provider],
      decrypt,
    );

    expect(endpoints).toEqual([]);
  });

  it('gives every tenant all models of a provider offered to all tenants, once', () => {
    const everyone: PlatformProvider = {
      ...provider,
      name: 'Everyone',
      label: 'For all',
      models: [{ id: 'a' }, { id: 'b' }],
      allTenants: true,
    };
    const assigned = catalogEndpoints(
      'tenant-a',
      { ...catalog, providers: [...catalog.providers, { name: 'Everyone', models: ['a'] }] },
      [provider, everyone],
      decrypt,
    );
    const withoutCatalog = catalogEndpoints('tenant-c', null, [everyone], decrypt);

    expect(assigned.map((e) => [e.name, e.models?.default])).toEqual([
      ['Mistral Platform', ['small', 'large']],
      ['Everyone', ['a', 'b']],
      ['Own', ['m']],
    ]);
    expect(withoutCatalog).toEqual([
      expect.objectContaining({
        name: 'Everyone',
        apiKey: 'operator-key',
        models: { default: ['a', 'b'], fetch: false },
        tenantId: 'tenant-c',
      }),
    ]);
  });
});

describe('createTenantEndpointLoader', () => {
  function setup(enabled = true) {
    let now = 0;
    const deps = {
      enabled,
      getTenantCatalog: jest.fn(async (tenantId: string) =>
        tenantId === 'tenant-a' ? catalog : null,
      ),
      findCatalogProviders: jest.fn(async (): Promise<PlatformProvider[]> => [provider]),
      decrypt,
      ttlMs: 1000,
      now: () => now,
    };
    return { deps, loader: createTenantEndpointLoader(deps), tick: (ms: number) => (now += ms) };
  }

  it('reuses a tenant catalog until it expires or is invalidated', async () => {
    const { deps, loader, tick } = setup();

    expect(await loader.load('tenant-a')).toHaveLength(2);
    await loader.load('tenant-a');
    expect(deps.getTenantCatalog).toHaveBeenCalledTimes(1);
    tick(1001);
    await loader.load('tenant-a');
    loader.invalidate('tenant-a');
    await loader.load('tenant-a');
    expect(deps.getTenantCatalog).toHaveBeenCalledTimes(3);
    expect(await loader.load('tenant-b')).toEqual([]);
  });

  it('serves providers offered to all tenants to a tenant without a catalog', async () => {
    const { deps, loader } = setup();
    deps.findCatalogProviders.mockResolvedValue([{ ...provider, allTenants: true }]);

    const endpoints = await loader.load('tenant-b');

    expect(deps.findCatalogProviders).toHaveBeenCalledWith([]);
    expect(endpoints).toEqual([
      expect.objectContaining({
        name: 'Mistral Platform',
        models: { default: ['small', 'medium', 'large'], fetch: false },
        tenantId: 'tenant-b',
      }),
    ]);
  });

  it('does not keep a failed read', async () => {
    const { deps, loader } = setup();
    deps.getTenantCatalog.mockRejectedValueOnce(new Error('db down'));

    await expect(loader.load('tenant-a')).rejects.toThrow('db down');
    expect(await loader.load('tenant-a')).toHaveLength(2);
  });

  it('gives no tenant anything while disabled', async () => {
    const { deps, loader } = setup(false);

    expect(await loader.load('tenant-a')).toEqual([]);
    expect(deps.getTenantCatalog).not.toHaveBeenCalled();
  });
});

describe('withTenantEndpoints', () => {
  it('adds the endpoints to the loaded and the raw custom endpoint lists', () => {
    const yaml = { name: 'Mistral EU', apiKey: '${MISTRAL}', baseURL: 'https://x', models: {} };
    const config = {
      endpoints: { custom: [yaml] },
      config: { endpoints: { custom: [yaml] } },
    } as unknown as AppConfig;
    const [endpoint] = catalogEndpoints('tenant-a', catalog, [provider], decrypt);

    const merged = withTenantEndpoints(config, [endpoint]);

    expect(merged.endpoints?.custom?.map((e) => e.name)).toEqual([
      'Mistral EU',
      'Mistral Platform',
    ]);
    expect(merged.config?.endpoints?.custom?.map((e) => e.name)).toEqual([
      'Mistral EU',
      'Mistral Platform',
    ]);
    expect(config.endpoints?.custom).toHaveLength(1);
    expect(withTenantEndpoints(config, [])).toBe(config);
  });
});

describe('getAppConfig with a tenant catalog', () => {
  const cacheStore = () => {
    const store = new Map<string, unknown>();
    return {
      get: jest.fn(async (key: string) => store.get(key)),
      set: jest.fn(async (key: string, value: unknown) => void store.set(key, value)),
      delete: jest.fn(async (key: string) => store.delete(key)),
    };
  };

  function service(failing = false) {
    const [endpoint] = catalogEndpoints('tenant-a', catalog, [provider], decrypt);
    const loadTenantEndpoints = jest.fn(async (tenantId: string) => {
      if (failing) throw new Error('db down');
      return tenantId === 'tenant-a' ? [endpoint] : [];
    });
    const { getAppConfig } = createAppConfigService({
      loadBaseConfig: jest.fn().mockResolvedValue({
        endpoints: { custom: [] },
        config: { endpoints: { custom: [] } },
      }),
      setCachedTools: jest.fn(),
      getCache: jest.fn().mockReturnValue(cacheStore()),
      cacheKeys: { APP_CONFIG: 'app_config' },
      getApplicableConfigs: jest.fn().mockResolvedValue([]),
      getUserPrincipals: jest.fn().mockResolvedValue([]),
      loadTenantEndpoints,
    } as unknown as Parameters<typeof createAppConfigService>[0]);
    return { getAppConfig, loadTenantEndpoints };
  }

  it("serves a tenant its catalog endpoints and nobody else's", async () => {
    const { getAppConfig } = service();

    const a = await getAppConfig({ tenantId: 'tenant-a', baseOnly: true });
    const b = await getAppConfig({ tenantId: 'tenant-b', baseOnly: true });
    const none = await getAppConfig({ baseOnly: true });

    expect(a.endpoints?.custom?.map((e) => e.name)).toEqual(['Mistral Platform']);
    expect(a.config?.endpoints?.custom?.map((e) => e.name)).toEqual(['Mistral Platform']);
    expect(b.endpoints?.custom ?? []).toEqual([]);
    expect(none.endpoints?.custom ?? []).toEqual([]);
  });

  it('falls back to the base config when the catalog cannot be read, unless fail-closed', async () => {
    const { getAppConfig } = service(true);

    expect(
      (await getAppConfig({ tenantId: 'tenant-a', baseOnly: true })).endpoints?.custom,
    ).toEqual([]);
    await expect(
      getAppConfig({ tenantId: 'tenant-a', baseOnly: true, failClosed: true }),
    ).rejects.toThrow('db down');
  });
});

describe('admin config reads of a tenant catalog', () => {
  it("never carry an assigned provider's key", async () => {
    const { redactConfigSecrets } = await import('~/admin/secrets');
    const [endpoint] = catalogEndpoints('tenant-a', catalog, [provider], decrypt);
    const config = withTenantEndpoints(
      { endpoints: { custom: [] }, config: { endpoints: { custom: [] } } } as unknown as AppConfig,
      [endpoint],
    );

    const safe = JSON.parse(JSON.stringify(config));
    redactConfigSecrets(safe);
    redactConfigSecrets(safe.config);

    expect(JSON.stringify(safe)).not.toContain('operator-key');
    expect(safe.config.endpoints.custom[0].name).toBe('Mistral Platform');
  });
});
