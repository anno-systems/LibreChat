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

  it('asks for the platform banner of the given tenant, and shows nothing without any', async () => {
    const findActivePlatformBanner = jest.fn(async () => null);
    const resolve = createBannerResolver({ getBanner: async () => null, findActivePlatformBanner });

    expect(await resolve({ id: 'u1' }, 'tenant-b')).toBeNull();
    expect(findActivePlatformBanner).toHaveBeenCalledWith('tenant-b');
  });
});
