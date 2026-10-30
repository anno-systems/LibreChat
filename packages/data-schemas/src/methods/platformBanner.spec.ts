import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPlatformBannerMethods } from './platformBanner';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPlatformBannerMethods>;

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  methods = createPlatformBannerMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PlatformBanner.deleteMany({});
});

describe('platform banners', () => {
  it('creates, updates, lists and deletes a banner', async () => {
    await methods.upsertPlatformBanner({
      bannerId: 'downtime',
      message: 'Maintenance tonight',
      displayFrom: day(20),
      displayTo: day(25),
      isPublic: true,
      persistable: false,
      tenantIds: ['tenant-a'],
    });
    const updated = await methods.upsertPlatformBanner({
      bannerId: 'downtime',
      message: 'Maintenance moved',
      displayFrom: day(21),
      isPublic: false,
      persistable: true,
    });

    expect(updated).toMatchObject({ bannerId: 'downtime', message: 'Maintenance moved' });
    expect(updated.displayTo).toBeUndefined();
    expect(updated.tenantIds).toBeUndefined();
    expect(await methods.listPlatformBanners()).toHaveLength(1);
    expect(await methods.deletePlatformBanner('downtime')).toBe(true);
    expect(await methods.deletePlatformBanner('downtime')).toBe(false);
  });

  it('finds the latest banner running now for a tenant, for all or for it', async () => {
    const base = { isPublic: false, persistable: false };
    await methods.upsertPlatformBanner({
      ...base,
      bannerId: 'all',
      message: 'For everyone',
      displayFrom: day(10),
    });
    await methods.upsertPlatformBanner({
      ...base,
      bannerId: 'b-only',
      message: 'For B',
      displayFrom: day(15),
      tenantIds: ['tenant-b'],
    });
    await methods.upsertPlatformBanner({
      ...base,
      bannerId: 'over',
      message: 'Past',
      displayFrom: day(16),
      displayTo: day(17),
    });
    await methods.upsertPlatformBanner({
      ...base,
      bannerId: 'later',
      message: 'Future',
      displayFrom: day(30),
    });

    const now = day(20);
    expect((await methods.findActivePlatformBanner('tenant-a', now))?.bannerId).toBe('all');
    expect((await methods.findActivePlatformBanner('tenant-b', now))?.bannerId).toBe('b-only');
    expect((await methods.findActivePlatformBanner(undefined, now))?.bannerId).toBe('all');
    expect(await methods.findActivePlatformBanner('tenant-a', day(5))).toBeNull();
  });

  it('stores a kind, defaults it to info and reads a banner saved without one as info', async () => {
    const base = { message: 'Notice', displayFrom: day(20), isPublic: false, persistable: false };
    const outage = await methods.upsertPlatformBanner({
      ...base,
      bannerId: 'down',
      kind: 'outage',
    });
    expect(outage.kind).toBe('outage');

    const plain = await methods.upsertPlatformBanner({ ...base, bannerId: 'plain' });
    expect(plain.kind).toBe('info');

    const reset = await methods.upsertPlatformBanner({ ...base, bannerId: 'down' });
    expect(reset.kind).toBe('info');

    await mongoose.models.PlatformBanner.collection.insertOne({
      ...base,
      bannerId: 'legacy',
      displayFrom: day(25),
    });
    expect((await methods.findActivePlatformBanner(undefined, day(26)))?.kind).toBe('info');
  });

  it('refuses a kind outside the list', async () => {
    await expect(
      methods.upsertPlatformBanner({
        bannerId: 'odd',
        message: 'Notice',
        displayFrom: day(20),
        isPublic: false,
        persistable: false,
        kind: 'party' as never,
      }),
    ).rejects.toThrow();
  });
});
