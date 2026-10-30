import type { TenantCosts } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminCostsHandler } from './costs';

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
  };
  return res as typeof res & Response;
}

const COSTS: TenantCosts = {
  from: '2026-10-01',
  to: '2026-10-21',
  totals: { tokenCredits: 3950, searchCredits: 4348, searches: 2, fetchCredits: 2174, fetches: 2 },
  daily: [],
  models: [],
};
const EUR = { code: 'EUR', rate: 0.92 };

const req = (query: Record<string, unknown>, tenantId: string | null = 'tenant-a') =>
  ({
    query,
    user: tenantId ? { id: 'admin-1', role: 'ADMIN', tenantId } : undefined,
  }) as unknown as ServerRequest;

function setup(canReadUsers = false) {
  const deps = {
    getTenantCosts: jest.fn(async () => COSTS),
    resolvePricing: jest.fn(() => ({ currency: EUR })),
    hasCapability: jest.fn(async () => canReadUsers),
  };
  return { deps, handler: createAdminCostsHandler(deps) };
}

describe('createAdminCostsHandler', () => {
  it("answers the tenant's costs for a day window, with the display currency", async () => {
    const { deps, handler } = setup();
    const res = mockRes();
    await handler(req({ days: '7', timeZone: 'Europe/Berlin' }), res);

    expect(deps.getTenantCosts).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      period: { days: 7 },
      timeZone: 'Europe/Berlin',
      byPerson: false,
    });
    expect(res.body).toEqual({ ...COSTS, currency: EUR });
  });

  it('defaults to 30 days and accepts a calendar month', async () => {
    const { deps, handler } = setup();
    await handler(req({}), mockRes());
    await handler(req({ month: '2026-10' }), mockRes());

    expect(deps.getTenantCosts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ period: { days: 30 } }),
    );
    expect(deps.getTenantCosts).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ period: { month: '2026-10' } }),
    );
  });

  it('names people only for callers who may read users', async () => {
    const { deps, handler } = setup(true);
    await handler(req({ days: '30' }), mockRes());

    expect(deps.hasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1' }),
      'read:users',
    );
    expect(deps.getTenantCosts).toHaveBeenCalledWith(expect.objectContaining({ byPerson: true }));
  });

  it.each([[{ days: '14' }], [{ month: '2026-13' }], [{ month: ['2026-10'] }]])(
    'refuses the period %j',
    async (query) => {
      const { deps, handler } = setup();
      const res = mockRes();
      await handler(req(query), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_period' });
      expect(deps.getTenantCosts).not.toHaveBeenCalled();
    },
  );

  it('needs a tenant', async () => {
    const { handler } = setup();
    const res = mockRes();
    await handler(req({}, null), res);

    expect(res.statusCode).toBe(400);
  });

  it('answers 500 without the query error', async () => {
    const { deps, handler } = setup();
    deps.getTenantCosts.mockRejectedValueOnce(new Error('aggregate failed: secret'));
    const res = mockRes();
    await handler(req({}), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load costs' });
  });
  it('adds the fixed monthly MCP server charges of the period, apart from the credits', async () => {
    const { deps } = setup();
    const at = (month: number, day: number) => new Date(Date.UTC(2026, month - 1, day));
    const subscriptions = [
      {
        id: 's1',
        tenantId: 'tenant-a',
        server: 'jira',
        price: 20,
        currency: 'EUR',
        acceptedBy: { id: 'admin-1' },
        acceptedAt: at(9, 20),
        periods: [{ start: at(9, 20) }],
        active: true,
      },
      {
        id: 's2',
        tenantId: 'tenant-a',
        server: 'personio',
        price: 15,
        currency: 'EUR',
        acceptedBy: { id: 'admin-1' },
        acceptedAt: at(8, 1),
        periods: [{ start: at(8, 1), end: at(8, 9) }],
        active: false,
      },
    ];
    const listMcpSubscriptions = jest.fn(async () => subscriptions);
    const handler = createAdminCostsHandler({
      ...deps,
      listMcpSubscriptions,
      listMcpServers: async () => [{ name: 'jira', title: 'Jira' }, { name: 'support' }],
      now: () => at(10, 21),
    });
    const res = mockRes();
    await handler(req({ month: '2026-10' }), res);

    expect(listMcpSubscriptions).toHaveBeenCalledWith('tenant-a');
    expect(res.body).toEqual({
      ...COSTS,
      currency: EUR,
      mcpServers: [
        {
          server: 'jira',
          label: 'Jira',
          price: 20,
          currency: 'EUR',
          months: ['2026-10'],
          amount: 20,
        },
      ],
    });
  });
});
