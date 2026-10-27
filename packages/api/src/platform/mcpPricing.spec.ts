import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createMcpSubscriptionHandlers } from '~/admin/subscriptions';
import { createMcpPricingHandlers } from './mcpPricing';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PlatformMcpPrice.deleteMany({});
  await mongoose.models.McpSubscription.collection.deleteMany({});
  await methods.loadMcpPricing();
});

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

const operatorReq = (params: Record<string, string> = {}, body: unknown = {}) =>
  ({
    params,
    body,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? 'olga' : undefined),
  }) as unknown as Request;

const adminReq = (server: string, body: unknown = {}, tenantId = 'tenant-a') =>
  ({
    params: { server },
    body,
    headers: {},
    get: () => undefined,
    user: { id: 'admin-1', _id: 'admin-1', name: 'Anna', role: 'ADMIN', tenantId },
  }) as unknown as ServerRequest;

const EUR = { code: 'EUR', rate: 0.92 };

function setup(currency: typeof EUR | null = EUR) {
  const recordAuditEntry = jest.fn(async () => undefined);
  const operator = createMcpPricingHandlers({
    store: methods,
    listServers: async () => [
      { name: 'support', title: 'Support' },
      { name: 'jira', title: 'Jira' },
      { name: 'personio', title: 'Personio' },
    ],
    resolvePricing: () => ({ ...(currency && { currency }) }),
    recordAuditEntry,
  });
  const admin = createMcpSubscriptionHandlers({ store: methods, recordAuditEntry });
  return { operator, admin, recordAuditEntry };
}

describe('MCP server prices (operator)', () => {
  it('sets a monthly price in the display currency and lists the servers', async () => {
    const { operator } = setup();
    const saved = mockRes();
    await operator.putMcpPrice(operatorReq({ server: 'jira' }, { monthlyPrice: 20 }), saved);
    expect(saved.body).toEqual({ price: { server: 'jira', monthlyPrice: 20, currency: 'EUR' } });

    const res = mockRes();
    await operator.getMcpPricing(operatorReq(), res);
    expect(res.body).toEqual({
      currency: 'EUR',
      servers: [
        { name: 'support', title: 'Support', alwaysFree: true, subscribers: 0 },
        { name: 'jira', title: 'Jira', monthlyPrice: 20, currency: 'EUR', subscribers: 0 },
        { name: 'personio', title: 'Personio', subscribers: 0 },
      ],
      subscriptions: [],
    });
  });

  it('refuses the support server, unknown servers, bad prices and prices without a currency', async () => {
    const { operator } = setup();
    const call = async (server: string, body: unknown) => {
      const res = mockRes();
      await operator.putMcpPrice(operatorReq({ server }, body), res);
      return [res.statusCode, (res.body as { error?: string }).error];
    };
    expect(await call('support', { monthlyPrice: 20 })).toEqual([400, 'server_always_free']);
    expect(await call('nope', { monthlyPrice: 20 })).toEqual([404, 'unknown_server']);
    expect(await call('jira', { monthlyPrice: -1 })).toEqual([400, 'invalid_price']);
    expect(await call('jira', { monthlyPrice: '20' })).toEqual([400, 'invalid_price']);
    expect(await call('a.b', { monthlyPrice: 20 })).toEqual([400, 'invalid_price']);

    const noCurrency = setup(null).operator;
    const res = mockRes();
    await noCurrency.putMcpPrice(operatorReq({ server: 'jira' }, { monthlyPrice: 20 }), res);
    expect([res.statusCode, res.body]).toEqual([409, { error: 'currency_required' }]);
    expect(await methods.listMcpServerPrices()).toEqual([]);
  });

  it('makes a server free again, ending running subscriptions in their tenant chains', async () => {
    const { operator, admin, recordAuditEntry } = setup();
    await operator.putMcpPrice(operatorReq({ server: 'jira' }, { monthlyPrice: 20 }), mockRes());
    await admin.subscribe(adminReq('jira', { monthlyPrice: 20, currency: 'EUR' }), mockRes());
    recordAuditEntry.mockClear();

    const listed = mockRes();
    await operator.getMcpPricing(operatorReq(), listed);
    expect((listed.body as { subscriptions: unknown[] }).subscriptions).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        server: 'jira',
        price: 20,
        acceptedBy: 'Anna',
        active: true,
      }),
    ]);

    const res = mockRes();
    await operator.deleteMcpPrice(operatorReq({ server: 'jira' }), res);
    expect(res.body).toEqual({ endedSubscriptions: 1 });
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp_server.unsubscribed',
        tenantId: 'tenant-a',
        actor: expect.objectContaining({ type: 'service', id: 'olga' }),
        metadata: expect.objectContaining({ reason: 'price_removed' }),
      }),
    );
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);

    const again = mockRes();
    await operator.deleteMcpPrice(operatorReq({ server: 'jira' }), again);
    expect(again.statusCode).toBe(404);
  });
});

describe('MCP server subscriptions (tenant admins)', () => {
  beforeEach(async () => {
    const { operator } = setup();
    await operator.putMcpPrice(operatorReq({ server: 'jira' }, { monthlyPrice: 20 }), mockRes());
  });

  it('lists the prices and needs consent to the current one', async () => {
    const { admin } = setup();
    const list = mockRes();
    await admin.listSubscriptions(adminReq(''), list);
    expect(list.body).toEqual({
      prices: [{ server: 'jira', monthlyPrice: 20, currency: 'EUR' }],
      subscriptions: [],
    });

    const none = mockRes();
    await admin.subscribe(adminReq('jira'), none);
    expect([none.statusCode, none.body]).toEqual([
      400,
      { error: 'consent_required', price: { monthlyPrice: 20, currency: 'EUR' } },
    ]);

    const stale = mockRes();
    await admin.subscribe(adminReq('jira', { monthlyPrice: 15, currency: 'EUR' }), stale);
    expect([stale.statusCode, stale.body]).toEqual([
      409,
      { error: 'price_changed', price: { monthlyPrice: 20, currency: 'EUR' } },
    ]);

    const free = mockRes();
    await admin.subscribe(adminReq('support', { monthlyPrice: 0, currency: 'EUR' }), free);
    expect(free.statusCode).toBe(400);
    const unpriced = mockRes();
    await admin.subscribe(adminReq('personio', { monthlyPrice: 20, currency: 'EUR' }), unpriced);
    expect([unpriced.statusCode, unpriced.body]).toEqual([404, { error: 'not_priced' }]);
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(true);
  });

  it('subscribes with consent, audits it, and ends it with the month still charged', async () => {
    const { admin, recordAuditEntry } = setup();
    const res = mockRes();
    await admin.subscribe(adminReq('jira', { monthlyPrice: 20, currency: 'EUR' }), res);
    expect(res.body).toMatchObject({
      change: 'created',
      subscription: {
        server: 'jira',
        price: 20,
        currency: 'EUR',
        acceptedBy: 'Anna',
        active: true,
        chargedThisMonth: true,
      },
    });
    expect(methods.isMcpServerUnpaid('jira', 'tenant-a')).toBe(false);
    expect(methods.isMcpServerUnpaid('jira', 'tenant-b')).toBe(true);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp_server.subscribed',
        tenantId: 'tenant-a',
        target: { type: 'mcp_server', id: 'jira', name: 'jira' },
        metadata: { price: 20, currency: 'EUR', resumed: false },
      }),
    );

    const ended = mockRes();
    await admin.unsubscribe(adminReq('jira'), ended);
    expect(ended.body).toMatchObject({
      subscription: { active: false, chargedThisMonth: true },
    });
    expect(recordAuditEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'mcp_server.unsubscribed', tenantId: 'tenant-a' }),
    );
    const twice = mockRes();
    await admin.unsubscribe(adminReq('jira'), twice);
    expect([twice.statusCode, twice.body]).toEqual([404, { error: 'not_subscribed' }]);
  });

  it('refuses a malformed consent', async () => {
    const { admin } = setup();
    for (const body of [
      { monthlyPrice: 20 },
      { monthlyPrice: 20, currency: 'eur' },
      { monthlyPrice: 20, currency: 'EUR', extra: true },
    ]) {
      const res = mockRes();
      await admin.subscribe(adminReq('jira', body), res);
      expect([res.statusCode, res.body]).toEqual([400, { error: 'invalid_subscription' }]);
    }
  });

  it('needs a tenant', async () => {
    const { admin } = setup();
    const res = mockRes();
    await admin.listSubscriptions({ ...adminReq('jira'), user: undefined } as ServerRequest, res);
    expect(res.statusCode).toBe(403);
  });
});
