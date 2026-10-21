import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
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

const mistral = {
  name: 'Mistral Platform',
  label: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  apiKey: 'v3:encrypted',
  models: ['small', 'large'],
  region: 'EU (Paris)',
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
      models: ['small'],
      region: undefined,
    });

    expect(updated).toMatchObject({ name: 'Mistral Platform', models: ['small'] });
    expect(updated.region).toBeUndefined();
    expect(await methods.listPlatformProviders()).toHaveLength(1);
    expect(await methods.findPlatformProviders(['Mistral Platform', 'Other'])).toHaveLength(1);
    expect(await methods.deletePlatformProvider('Mistral Platform')).toBe(true);
    expect(await methods.deletePlatformProvider('Mistral Platform')).toBe(false);
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
    const own = { name: 'Own', baseURL: 'https://llm.a.example/v1', apiKey: 'k', models: ['x'] };

    await methods.upsertOwnEndpoint('tenant-a', own);
    const replaced = await methods.upsertOwnEndpoint('tenant-a', { ...own, models: ['y'] });

    expect(replaced.own).toEqual([{ ...own, models: ['y'] }]);
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
      models: ['x'],
    });

    const catalog = await methods.setTenantAssignments('tenant-a', { byok: true, providers: [] });

    expect(catalog.own).toHaveLength(1);
  });
});
