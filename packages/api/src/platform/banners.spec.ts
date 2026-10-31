import type { PlatformBanner } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ShownBanner } from './banners';
import { createBannerResolver, createPlatformBannerHandlers } from './banners';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res as typeof res & Response;
}

const req = (id: string, body: unknown = {}) => ({ params: { id }, body }) as unknown as Request;

function setup() {
  const stored = new Map<string, PlatformBanner>();
  const store = {
    listPlatformBanners: jest.fn(async () => [...stored.values()]),
    upsertPlatformBanner: jest.fn(async (banner: PlatformBanner) => {
      stored.set(banner.bannerId, banner);
      return banner;
    }),
    deletePlatformBanner: jest.fn(async (id: string) => stored.delete(id)),
  };
  return { store, stored, handlers: createPlatformBannerHandlers(store) };
}

describe('platform banner handlers', () => {
  it('saves a banner for chosen tenants and lists and deletes it', async () => {
    const { handlers, stored } = setup();
    const res = mockRes();

    await handlers.putBanner(
      req('downtime', {
        message: 'Maintenance <b>tonight</b>',
        displayFrom: '2026-10-23T18:00:00Z',
        displayTo: '2026-10-23T22:00:00Z',
        tenantIds: ['tenant-a', 'tenant-a'],
        persistable: true,
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(stored.get('downtime')).toEqual({
      bannerId: 'downtime',
      message: 'Maintenance <b>tonight</b>',
      displayFrom: new Date('2026-10-23T18:00:00Z'),
      displayTo: new Date('2026-10-23T22:00:00Z'),
      tenantIds: ['tenant-a'],
      isPublic: false,
      persistable: true,
      kind: 'info',
    });
    const list = mockRes();
    await handlers.listBanners(req(''), list);
    expect((list.body as { banners: unknown[] }).banners).toHaveLength(1);
    const gone = mockRes();
    await handlers.deleteBanner(req('downtime'), gone);
    expect(gone.statusCode).toBe(204);
    const missing = mockRes();
    await handlers.deleteBanner(req('downtime'), missing);
    expect(missing.statusCode).toBe(404);
  });

  it.each([
    ['an id with slashes', 'a/b', { message: 'x', displayFrom: '2026-10-23T18:00:00Z' }],
    ['no message', 'ok', { message: ' ', displayFrom: '2026-10-23T18:00:00Z' }],
    [
      'an end before the start',
      'ok',
      {
        message: 'x',
        displayFrom: '2026-10-23T18:00:00Z',
        displayTo: '2026-10-23T17:00:00Z',
      },
    ],
    [
      'an unknown field',
      'ok',
      { message: 'x', displayFrom: '2026-10-23T18:00:00Z', type: 'popup' },
    ],
    ['an unknown kind', 'ok', { message: 'x', displayFrom: '2026-10-23T18:00:00Z', kind: 'party' }],
    [
      'a bad tenant id',
      'ok',
      {
        message: 'x',
        displayFrom: '2026-10-23T18:00:00Z',
        tenantIds: ['../x'],
      },
    ],
  ])('refuses %s', async (_label, id, body) => {
    const { handlers, store } = setup();
    const res = mockRes();

    await handlers.putBanner(req(id, body), res);

    expect(res.statusCode).toBe(400);
    expect(store.upsertPlatformBanner).not.toHaveBeenCalled();
  });
});

describe('platform banner kinds', () => {
  it.each(['info', 'maintenance', 'warning', 'outage'] as const)(
    'stores the kind %s',
    async (kind) => {
      const { handlers, stored } = setup();
      const res = mockRes();

      await handlers.putBanner(
        req('notice', { message: 'x', displayFrom: '2026-10-23T18:00:00Z', kind }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(stored.get('notice')?.kind).toBe(kind);
    },
  );
});

describe('banner resolver', () => {
  const own: ShownBanner = {
    bannerId: 'own',
    message: 'Tenant news',
    displayFrom: new Date('2026-10-10T00:00:00Z'),
    type: 'banner',
    isPublic: true,
    persistable: false,
  };
  const platform: PlatformBanner = {
    bannerId: 'platform',
    message: 'Platform news',
    displayFrom: new Date('2026-10-20T00:00:00Z'),
    isPublic: false,
    persistable: true,
  };

  it('shows the later of the tenant banner and the platform banner', async () => {
    const resolve = createBannerResolver({
      getBanner: async () => own,
      findActivePlatformBanner: async () => platform,
    });

    expect((await resolve({ id: 'u1' }, 'tenant-a'))?.bannerId).toBe('platform');
    // Signed out, a platform banner that is not public stays hidden.
    expect((await resolve(undefined, 'tenant-a'))?.bannerId).toBe('own');
  });

  it('passes the platform banner kind on, as info when it has none, and none for the tenant', async () => {
    const shown = (banner: PlatformBanner, ownBanner: ShownBanner | null = null) =>
      createBannerResolver({
        getBanner: async () => ownBanner,
        findActivePlatformBanner: async () => banner,
      })({ id: 'u1' }, 'tenant-a');

    expect((await shown({ ...platform, kind: 'outage' }))?.kind).toBe('outage');
    expect((await shown(platform))?.kind).toBe('info');
    const later = { ...own, displayFrom: new Date('2026-10-30T00:00:00Z') };
    expect((await shown({ ...platform, kind: 'warning' }, later))?.kind).toBeUndefined();
  });

  it('skips the tenant banner for a request without a tenant under strict isolation', async () => {
    const getBanner = jest.fn(async () => own);
    const resolve = createBannerResolver({
      getBanner,
      findActivePlatformBanner: async () => ({ ...platform, isPublic: true }),
      ownWithoutTenant: false,
    });

    expect((await resolve(undefined, undefined))?.bannerId).toBe('platform');
    expect(getBanner).not.toHaveBeenCalled();
    expect((await resolve(undefined, 'tenant-a'))?.bannerId).toBe('platform');
    expect(getBanner).toHaveBeenCalledTimes(1);
    // Without the option (single-tenant), the banner is looked up as upstream does.
    const upstream = createBannerResolver({
      getBanner,
      findActivePlatformBanner: async () => null,
    });
    expect((await upstream(undefined, undefined))?.bannerId).toBe('own');
  });

  it('asks for the platform banner of the given tenant, and shows nothing without any', async () => {
    const findActivePlatformBanner = jest.fn(async () => null);
    const resolve = createBannerResolver({ getBanner: async () => null, findActivePlatformBanner });

    expect(await resolve({ id: 'u1' }, 'tenant-b')).toBeNull();
    expect(findActivePlatformBanner).toHaveBeenCalledWith('tenant-b');
  });
});
