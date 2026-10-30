import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PlatformProvider } from './platformCatalog';
import { createPlatformCatalogMethods } from './platformCatalog';
import { tenantStorage } from '../config/tenantContext';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPlatformCatalogMethods>;

const mistral: PlatformProvider = {
  name: 'Mistral Platform',
  label: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  apiKey: 'v3:encrypted',
  models: [{ id: 'small', label: 'Mistral Small' }, { id: 'large' }],
  location: { type: 'country', code: 'FR' },
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  methods = createPlatformCatalogMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PlatformProvider.deleteMany({});
  await tenantStorage.run(
    { tenantId: '__SYSTEM__' },
    async () => await mongoose.models.TenantCatalog.deleteMany({}),
  );
});

describe('platform providers', () => {
  it('creates, updates, lists and deletes a provider', async () => {
    await methods.upsertPlatformProvider(mistral);
    const updated = await methods.upsertPlatformProvider({
      ...mistral,
      models: [{ id: 'small', location: { type: 'eu' } }],
      location: undefined,
    });

    expect(updated).toMatchObject({
      name: 'Mistral Platform',
      models: [{ id: 'small', location: { type: 'eu' } }],
    });
    expect(updated.location).toBeUndefined();
    expect(await methods.listPlatformProviders()).toHaveLength(1);
    expect(await methods.findPlatformProviders(['Mistral Platform', 'Other'])).toHaveLength(1);
    expect(await methods.deletePlatformProvider('Mistral Platform')).toBe(true);
    expect(await methods.deletePlatformProvider('Mistral Platform')).toBe(false);
  });

  it('creates a provider only under a free name', async () => {
    const created = await methods.createPlatformProvider(mistral);
    expect(created).toEqual({ ok: true, value: expect.objectContaining({ name: mistral.name }) });
    expect(await methods.createPlatformProvider({ ...mistral, label: 'Other' })).toEqual({
      ok: false,
      error: { code: 'name_taken' },
    });
    expect((await methods.findPlatformProviders([mistral.name]))[0].label).toBe('Mistral');
  });

  it('keeps an empty drop list apart from none and clears it on an update without one', async () => {
    const empty = await methods.upsertPlatformProvider({ ...mistral, dropParams: [] });
    expect(empty.dropParams).toEqual([]);

    await methods.upsertPlatformProvider({ ...mistral, dropParams: ['user', 'stop'] });
    expect((await methods.findPlatformProviders([mistral.name]))[0].dropParams).toEqual([
      'user',
      'stop',
    ]);

    const cleared = await methods.upsertPlatformProvider(mistral);
    expect(cleared).not.toHaveProperty('dropParams');
  });

  it('stores limits per model and queue settings with only the fields set', async () => {
    const limited = await methods.upsertPlatformProvider({
      ...mistral,
      models: [{ id: 'small', limits: { concurrency: 3 } }, { id: 'large' }],
      queue: { maxWaitSeconds: 60 },
    });
    expect(limited.models).toEqual([{ id: 'small', limits: { concurrency: 3 } }, { id: 'large' }]);
    expect(limited.queue).toEqual({ maxWaitSeconds: 60 });

    const cleared = await methods.upsertPlatformProvider(mistral);
    expect(cleared).not.toHaveProperty('queue');
    expect(cleared.models.every((model) => model.limits == null)).toBe(true);
  });

  it('stores the all-tenants flag and finds those providers with the named ones', async () => {
    const created = await methods.upsertPlatformProvider(mistral);
    expect(created.allTenants).toBe(false);
    await methods.upsertPlatformProvider({ ...mistral, name: 'Everyone', allTenants: true });
    await methods.upsertPlatformProvider({ ...mistral, name: 'Other' });

    expect((await methods.findCatalogProviders([])).map((p) => p.name)).toEqual(['Everyone']);
    expect(
      (await methods.findCatalogProviders(['Mistral Platform', 'Everyone'])).map((p) => [
        p.name,
        p.allTenants,
      ]),
    ).toEqual([
      ['Everyone', true],
      ['Mistral Platform', false],
    ]);

    await methods.upsertPlatformProvider({ ...mistral, name: 'Everyone', allTenants: false });
    expect(await methods.findCatalogProviders([])).toEqual([]);
  });
});

describe('per-model APIs and keyless providers', () => {
  it("stores each model's API, base URL and request fields, and reads an old model without them", async () => {
    const saved = await methods.upsertPlatformProvider({
      ...mistral,
      baseURL: undefined,
      models: [
        { id: 'gpt-6.1-terra', api: 'responses', baseURL: 'https://x.example/openai/v1' },
        {
          id: 'claude',
          api: 'anthropic',
          baseURL: 'https://x.example/anthropic/v1',
          dropParams: [],
        },
      ],
    });
    expect(saved).not.toHaveProperty('baseURL');
    expect(saved.models).toEqual([
      { id: 'gpt-6.1-terra', api: 'responses', baseURL: 'https://x.example/openai/v1' },
      { id: 'claude', api: 'anthropic', baseURL: 'https://x.example/anthropic/v1', dropParams: [] },
    ]);

    await mongoose.models.PlatformProvider.collection.insertOne({
      name: 'Old',
      label: 'Old',
      baseURL: 'https://api.example/v1',
      apiKey: 'v3:encrypted',
      models: [{ id: 'small', api: 'gemini' }],
      dropParams: ['user'],
      allTenants: false,
    });
    const [old] = await methods.findPlatformProviders(['Old']);
    /** An unknown API is not one: the model is served as Chat Completions. */
    expect(old).toMatchObject({ baseURL: 'https://api.example/v1', dropParams: ['user'] });
    expect(old.models).toEqual([{ id: 'small' }]);
  });

  it('stores a provider without a key and removes a key an update leaves out', async () => {
    const { apiKey: _key, ...keyless } = mistral;
    const created = await methods.createPlatformProvider(keyless);
    expect(created.ok && created.value).not.toHaveProperty('apiKey');

    await methods.upsertPlatformProvider(mistral);
    expect((await methods.findPlatformProviders([mistral.name]))[0].apiKey).toBe('v3:encrypted');

    await methods.upsertPlatformProvider(keyless);
    const raw = await mongoose.models.PlatformProvider.collection.findOne({ name: mistral.name });
    expect(raw).not.toHaveProperty('apiKey');
  });
});

describe('model vendors', () => {
  it("stores an operator's vendor and reads documents without one, or with an unknown one, without it", async () => {
    const saved = await methods.upsertPlatformProvider({
      ...mistral,
      models: [{ id: 'house-model', vendor: 'mistral' }, { id: 'claude-sonnet-5-5' }],
    });
    expect(saved.models).toEqual([
      { id: 'house-model', vendor: 'mistral' },
      { id: 'claude-sonnet-5-5' },
    ]);

    await mongoose.models.PlatformProvider.collection.insertOne({
      name: 'Old',
      label: 'Old',
      baseURL: 'https://api.example/v1',
      apiKey: 'v3:encrypted',
      models: ['mistral-medium-3-5', { id: 'gpt-6.1-terra', vendor: 'acme' }],
      allTenants: false,
    });
    const [old] = await methods.findPlatformProviders(['Old']);
    /** Without a stored vendor, readers detect it from the id (`vendorOf`). */
    expect(old.models).toEqual([{ id: 'mistral-medium-3-5' }, { id: 'gpt-6.1-terra' }]);
  });

  it("keeps the vendor of a tenant's own models", async () => {
    await methods.setTenantAssignments('tenant-v', { byok: true, providers: [] });
    const stored = await methods.upsertOwnEndpoint('tenant-v', {
      name: 'Own',
      baseURL: 'https://llm.example/v1',
      apiKey: 'v3:encrypted',
      models: [{ id: 'mine', vendor: 'meta' }],
    });
    expect(stored.own[0].models).toEqual([{ id: 'mine', vendor: 'meta' }]);
    expect((await methods.getTenantCatalog('tenant-v'))?.own[0].models).toEqual([
      { id: 'mine', vendor: 'meta' },
    ]);
  });
});

describe('tenant catalogs', () => {
  it('is null until the operator sets it', async () => {
    expect(await methods.getTenantCatalog('tenant-a')).toBeNull();
  });

  it('keeps each tenant to its own catalog', async () => {
    await methods.setTenantAssignments('tenant-a', {
      byok: true,
      providers: [{ name: 'Mistral Platform', models: ['small'] }],
    });
    await methods.setTenantAssignments('tenant-b', { byok: false, providers: [] });

    expect(await methods.getTenantCatalog('tenant-a')).toEqual({
      tenantId: 'tenant-a',
      byok: true,
      providers: [{ name: 'Mistral Platform', models: ['small'] }],
      own: [],
    });
    expect((await methods.getTenantCatalog('tenant-b'))?.providers).toEqual([]);
    expect(await methods.tenantsUsingProvider('Mistral Platform')).toEqual(['tenant-a']);
  });

  it('adds, replaces and removes a tenant endpoint without touching the assignment', async () => {
    await methods.setTenantAssignments('tenant-a', {
      byok: true,
      providers: [{ name: 'Mistral Platform', models: ['small'] }],
    });
    const own = {
      name: 'Own',
      baseURL: 'https://llm.a.example/v1',
      apiKey: 'k',
      models: [{ id: 'x' }],
    };

    await methods.upsertOwnEndpoint('tenant-a', own);
    const replaced = await methods.upsertOwnEndpoint('tenant-a', {
      ...own,
      location: { type: 'global' },
      models: [{ id: 'y', label: 'Why', location: { type: 'country', code: 'DE' } }],
    });

    expect(replaced.own).toEqual([
      {
        ...own,
        location: { type: 'global' },
        models: [{ id: 'y', label: 'Why', location: { type: 'country', code: 'DE' } }],
      },
    ]);
    const dropping = await methods.upsertOwnEndpoint('tenant-a', { ...own, dropParams: ['user'] });
    expect(dropping.own[0].dropParams).toEqual(['user']);
    expect((await methods.upsertOwnEndpoint('tenant-a', own)).own[0]).not.toHaveProperty(
      'dropParams',
    );
    expect(replaced.providers).toHaveLength(1);
    expect((await methods.getTenantCatalog('tenant-b'))?.own ?? []).toEqual([]);
    expect(await methods.deleteOwnEndpoint('tenant-b', 'Own')).toBe(false);
    expect(await methods.deleteOwnEndpoint('tenant-a', 'Own')).toBe(true);
    expect((await methods.getTenantCatalog('tenant-a'))?.own).toEqual([]);
  });

  it('keeps tenant endpoints when the operator changes the assignment', async () => {
    await methods.upsertOwnEndpoint('tenant-a', {
      name: 'Own',
      baseURL: 'https://llm.a.example/v1',
      apiKey: 'k',
      models: [{ id: 'x' }],
    });

    const catalog = await methods.setTenantAssignments('tenant-a', { byok: true, providers: [] });

    expect(catalog.own).toHaveLength(1);
  });
});

describe('documents of the old shape', () => {
  const legacy = {
    name: 'Legacy',
    label: 'Legacy',
    baseURL: 'https://api.example/v1',
    apiKey: 'v3:encrypted',
    models: ['small', 'large'],
    region: 'EU (Paris)',
    country: 'fr',
    limits: { concurrency: 2, tokensPerMinute: 5000, maxWaitSeconds: 60, pauseSeconds: 5 },
    allTenants: false,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  const legacyCatalog = {
    tenantId: 'tenant-a',
    byok: true,
    providers: [{ name: 'Legacy', models: ['small'] }],
    own: [{ name: 'Own', baseURL: 'https://llm.a.example/v1', apiKey: 'k', models: ['x', 'y'] }],
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  const expected: PlatformProvider = {
    name: 'Legacy',
    label: 'Legacy',
    baseURL: 'https://api.example/v1',
    apiKey: 'v3:encrypted',
    models: [
      { id: 'small', limits: { concurrency: 2, tokensPerMinute: 5000 } },
      { id: 'large', limits: { concurrency: 2, tokensPerMinute: 5000 } },
    ],
    location: { type: 'country', code: 'FR' },
    allTenants: false,
    queue: { maxWaitSeconds: 60, pauseSeconds: 5 },
  };

  /** Written as an older replica stores them, past the schema. */
  async function insertLegacy() {
    await mongoose.models.PlatformProvider.collection.insertOne({ ...legacy });
    await mongoose.models.TenantCatalog.collection.insertOne({ ...legacyCatalog });
  }

  it('reads them in the new shape before they are migrated', async () => {
    await insertLegacy();
    const [provider] = await methods.findPlatformProviders(['Legacy']);
    expect(provider).toMatchObject(expected);
    expect(provider).not.toHaveProperty('region');
    expect(provider).not.toHaveProperty('limits');
    expect((await methods.getTenantCatalog('tenant-a'))?.own[0].models).toEqual([
      { id: 'x' },
      { id: 'y' },
    ]);
  });

  it('migrates them once, idempotently, and leaves new documents alone', async () => {
    await insertLegacy();
    await methods.upsertPlatformProvider(mistral);

    expect(await methods.migratePlatformCatalog()).toEqual({ providers: 1, tenants: 1 });
    expect(await methods.migratePlatformCatalog()).toEqual({ providers: 0, tenants: 0 });

    const raw = await mongoose.models.PlatformProvider.collection.findOne({ name: 'Legacy' });
    expect(raw).not.toHaveProperty('region');
    expect(raw).not.toHaveProperty('country');
    expect(raw).not.toHaveProperty('limits');
    expect(raw?.models).toEqual(expected.models);
    expect(raw?.location).toEqual({ type: 'country', code: 'FR' });
    expect(raw?.queue).toEqual({ maxWaitSeconds: 60, pauseSeconds: 5 });
    expect((await methods.findPlatformProviders(['Legacy']))[0]).toMatchObject(expected);

    const catalog = await mongoose.models.TenantCatalog.collection.findOne({
      tenantId: 'tenant-a',
    });
    expect(catalog?.own[0].models).toEqual([{ id: 'x' }, { id: 'y' }]);
    expect(catalog?.providers).toEqual([{ name: 'Legacy', models: ['small'] }]);
  });

  it('drops the old fields when an unmigrated provider is saved', async () => {
    await insertLegacy();
    const [provider] = await methods.findPlatformProviders(['Legacy']);
    await methods.upsertPlatformProvider(provider);
    const raw = await mongoose.models.PlatformProvider.collection.findOne({ name: 'Legacy' });
    expect(raw).not.toHaveProperty('country');
    expect(raw).not.toHaveProperty('limits');
    expect(raw?.models[0]).toEqual({
      id: 'small',
      limits: { concurrency: 2, tokensPerMinute: 5000 },
    });
  });
});
