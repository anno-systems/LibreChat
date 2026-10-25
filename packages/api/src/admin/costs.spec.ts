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
  totals: { tokenCredits: 3950, searchCredits: 4348, searches: 2 },
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
});
