import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMcpPricingMethods, chargedMonths } from './mcpPricing';
import { tenantStorage } from '../config/tenantContext';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PlatformMcpPrice?.deleteMany({});
  await mongoose.models.McpSubscription?.collection.deleteMany({});
});

const admin = { id: 'u1', name: 'Anna' };
const oct = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour));
const nov = (day: number) => new Date(Date.UTC(2026, 10, day, 12));
const dec = (day: number) => new Date(Date.UTC(2026, 11, day, 12));

describe('MCP server pricing', () => {
  it('leaves every server free until the operator sets a price', async () => {
    const methods = createMcpPricingMethods(mongoose);
    await methods.loadMcpPricing();

    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);
    expect(await methods.listMcpServerPrices()).toEqual([]);
  });

  it('never prices the support server', async () => {
    const methods = createMcpPricingMethods(mongoose);
    const result = await methods.setMcpServerPrice({
      server: 'support',
      monthlyPrice: 20,
      currency: 'EUR',
    });

    expect(result).toEqual({ ok: false, error: { code: 'always_free' } });
    expect(await methods.listMcpServerPrices()).toEqual([]);
    expect(
      await methods.subscribeMcpServer({
        tenantId: 'tenant-a',
        server: 'support',
        consent: { monthlyPrice: 20, currency: 'EUR' },
        acceptedBy: admin,
      }),
    ).toEqual({ ok: false, error: { code: 'always_free' } });
  });

  it('turns a priced server off for tenants without a subscription, per tenant', async () => {
    const methods = createMcpPricingMethods(mongoose);
    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 20, currency: 'EUR' });

    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(true);
    expect(methods.isMcpServerUnpaid('slack', 'tenant-a')).toBe(false);
    // No tenant (startup, system jobs): nothing to charge, nothing to turn off.
    expect(methods.isMcpServerUnpaid('jira')).toBe(false);
    expect(methods.isMcpServerUnpaid('jira', '__SYSTEM__')).toBe(false);
    // The caller's tenant by default.
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      expect(methods.isMcpServerUnpaid('jira')).toBe(true);
    });

    const result = await methods.subscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      consent: { monthlyPrice: 20, currency: 'EUR' },
      acceptedBy: admin,
      now: oct(5),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        change: 'created',
        subscription: {
          tenantId: 'tenant-a',
          server: 'jira',
          price: 20,
          currency: 'EUR',
          acceptedBy: admin,
          acceptedAt: oct(5),
          periods: [{ start: oct(5) }],
          active: true,
        },
      },
    });
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);
    expect(methods.isMcpServerUnpaid('jira', 'tenant-b')).toBe(true);

    // Another process sees the same after loading from the database.
    const other = createMcpPricingMethods(mongoose);
    await other.loadMcpPricing();
    expect(other.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);
    expect(other.isMcpServerUnpaid('jira', 'tenant-b')).toBe(true);
  });

  it('needs consent to the current price', async () => {
    const methods = createMcpPricingMethods(mongoose);
    expect(
      await methods.subscribeMcpServer({ tenantId: 'tenant-a', server: 'jira', acceptedBy: admin }),
    ).toEqual({ ok: false, error: { code: 'not_priced' } });

    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 20, currency: 'EUR' });
    expect(
      await methods.subscribeMcpServer({ tenantId: 'tenant-a', server: 'jira', acceptedBy: admin }),
    ).toEqual({
      ok: false,
      error: { code: 'consent_required', price: { monthlyPrice: 20, currency: 'EUR' } },
    });
    expect(
      await methods.subscribeMcpServer({
        tenantId: 'tenant-a',
        server: 'jira',
        consent: { monthlyPrice: 15, currency: 'EUR' },
        acceptedBy: admin,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'price_changed', price: { monthlyPrice: 20, currency: 'EUR' } },
    });
    expect(
      await methods.subscribeMcpServer({
        tenantId: 'tenant-a',
        server: 'jira',
        consent: { monthlyPrice: 20, currency: 'USD' },
        acceptedBy: admin,
      }),
    ).toMatchObject({ ok: false, error: { code: 'price_changed' } });
    expect(await methods.listMcpSubscriptions('tenant-a')).toEqual([]);
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(true);
  });

  it('keeps the accepted price when the operator changes it, and asks again for a new subscription', async () => {
    const methods = createMcpPricingMethods(mongoose);
    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 20, currency: 'EUR' });
    const consent = { monthlyPrice: 20, currency: 'EUR' };
    await methods.subscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      consent,
      acceptedBy: admin,
      now: oct(5),
    });
    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 25, currency: 'EUR' });

    // Still on, at 20.
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);
    const again = await methods.subscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      acceptedBy: admin,
      now: oct(6),
    });
    expect(again).toMatchObject({ ok: true, value: { change: 'unchanged' } });

    // Off in October; back on in December after a month without it: the new price needs consent.
    await methods.unsubscribeMcpServer({ tenantId: 'tenant-a', server: 'jira', now: oct(20) });
    expect(
      await methods.subscribeMcpServer({
        tenantId: 'tenant-a',
        server: 'jira',
        consent,
        acceptedBy: admin,
        now: dec(2),
      }),
    ).toMatchObject({ ok: false, error: { code: 'price_changed' } });
    const renewed = await methods.subscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      consent: { monthlyPrice: 25, currency: 'EUR' },
      acceptedBy: admin,
      now: dec(2),
    });
    expect(renewed).toMatchObject({ ok: true, value: { change: 'created' } });

    expect(
      await methods.listMcpCharges({
        tenantId: 'tenant-a',
        from: '2026-09-01',
        to: '2026-12-31',
        now: dec(10),
      }),
    ).toEqual([
      { server: 'jira', price: 20, currency: 'EUR', months: ['2026-10'] },
      { server: 'jira', price: 25, currency: 'EUR', months: ['2026-12'] },
    ]);
  });

  it('charges a month once, keeps it charged when switched off, and resumes it for free', async () => {
    const methods = createMcpPricingMethods(mongoose);
    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 20, currency: 'EUR' });
    await methods.subscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      consent: { monthlyPrice: 20, currency: 'EUR' },
      acceptedBy: admin,
      now: oct(5),
    });

    const ended = await methods.unsubscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      now: oct(10),
    });
    expect(ended).toMatchObject({ active: false, periods: [{ start: oct(5), end: oct(10) }] });
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(true);
    expect(
      await methods.unsubscribeMcpServer({ tenantId: 'tenant-a', server: 'jira', now: oct(11) }),
    ).toBeNull();

    // Same month: no consent needed, nothing extra.
    const resumed = await methods.subscribeMcpServer({
      tenantId: 'tenant-a',
      server: 'jira',
      acceptedBy: { id: 'u2' },
      now: oct(15),
    });
    expect(resumed).toMatchObject({
      ok: true,
      value: {
        change: 'resumed',
        subscription: {
          acceptedBy: admin,
          periods: [{ start: oct(5), end: oct(10) }, { start: oct(15) }],
          active: true,
        },
      },
    });
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);

    const charges = (from: string, to: string) =>
      methods.listMcpCharges({ tenantId: 'tenant-a', from, to, now: nov(3) });
    expect(await charges('2026-10-01', '2026-10-31')).toEqual([
      { server: 'jira', price: 20, currency: 'EUR', months: ['2026-10'] },
    ]);
    // Still running in November.
    expect(await charges('2026-10-15', '2026-11-13')).toEqual([
      { server: 'jira', price: 20, currency: 'EUR', months: ['2026-10', '2026-11'] },
    ]);
    expect(await charges('2026-09-01', '2026-09-30')).toEqual([]);
    // Another tenant pays nothing.
    expect(
      await methods.listMcpCharges({
        tenantId: 'tenant-b',
        from: '2026-10-01',
        to: '2026-10-31',
        now: nov(3),
      }),
    ).toEqual([]);
  });

  it('ends running subscriptions when the operator makes a server free', async () => {
    const methods = createMcpPricingMethods(mongoose);
    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 20, currency: 'EUR' });
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      await methods.subscribeMcpServer({
        tenantId,
        server: 'jira',
        consent: { monthlyPrice: 20, currency: 'EUR' },
        acceptedBy: admin,
        now: oct(5),
      });
    }

    const { removed, ended } = await methods.deleteMcpServerPrice('jira', oct(8));
    expect(removed).toBe(true);
    expect(ended.map((s) => s.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);
    expect(await methods.listMcpSubscriptions()).toEqual([
      expect.objectContaining({ tenantId: 'tenant-a', active: false }),
      expect.objectContaining({ tenantId: 'tenant-b', active: false }),
    ]);
    expect(await methods.deleteMcpServerPrice('jira')).toEqual({ removed: false, ended: [] });
  });

  it('keeps one running subscription when two admins agree at once', async () => {
    const methods = createMcpPricingMethods(mongoose);
    await mongoose.models.McpSubscription.syncIndexes();
    await methods.setMcpServerPrice({ server: 'jira', monthlyPrice: 20, currency: 'EUR' });
    const subscribe = () =>
      methods.subscribeMcpServer({
        tenantId: 'tenant-a',
        server: 'jira',
        consent: { monthlyPrice: 20, currency: 'EUR' },
        acceptedBy: admin,
        now: oct(5),
      });

    const results = await Promise.all([subscribe(), subscribe()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await methods.listMcpSubscriptions('tenant-a')).toHaveLength(1);
  });
});

describe('chargedMonths', () => {
  it('lists every month a period touches, across years', () => {
    expect(chargedMonths([{ start: new Date(Date.UTC(2026, 10, 30)) }], dec(1))).toEqual([
      '2026-11',
      '2026-12',
    ]);
    expect(
      chargedMonths(
        [{ start: new Date(Date.UTC(2026, 11, 31)), end: new Date(Date.UTC(2027, 0, 1)) }],
        dec(1),
      ),
    ).toEqual(['2026-12', '2027-01']);
  });
});
