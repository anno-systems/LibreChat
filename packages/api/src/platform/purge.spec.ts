import type { TenantUserTarget } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createTenantPurgeHandler, purgeTenant } from './purge';

const mockEraseUserData = jest.fn();
jest.mock('~/user/erasure', () => ({
  eraseUserData: (...args: unknown[]) => mockEraseUserData(...args),
}));

const users: TenantUserTarget[] = [
  { id: 'a'.repeat(24), role: 'ADMIN', tenantId: 'acme', profile: { email: 'ada@acme.test' } },
  { id: 'b'.repeat(24), role: 'USER', tenantId: 'acme', profile: { email: 'bo@acme.test' } },
];

function setup() {
  const order: string[] = [];
  const deps = {
    purge: {
      listTenantUserTargets: jest.fn(async () => users),
      purgeTenantDocuments: jest.fn(async () => {
        order.push('sweep');
        return { Conversation: 3, Group: 1 };
      }),
    },
    resolveErasure: jest.fn(async (target: { id: string }) => {
      order.push(`resolve ${target.id.slice(0, 1)}`);
      return { deps: { marker: target.id } as never, checkpointer: undefined };
    }),
    deleteUserById: jest.fn(async (id: string) => {
      order.push(`delete ${id.slice(0, 1)}`);
    }),
    invalidate: jest.fn(async () => {
      order.push('invalidate');
    }),
    recordAuditEntry: jest.fn().mockResolvedValue(undefined),
  };
  return { deps, order };
}

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
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const req = (tenantId: string, body: unknown) =>
  ({
    params: { tenantId },
    body,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? 'olga' : undefined),
  }) as unknown as Request;

beforeEach(() => {
  mockEraseUserData.mockReset();
  mockEraseUserData.mockImplementation(async () => undefined);
});

describe('purgeTenant', () => {
  it("erases each user's data, deletes the user, then sweeps the tenant", async () => {
    const { deps, order } = setup();

    const result = await purgeTenant('acme', deps);

    expect(result).toEqual({ users: 2, documents: { Conversation: 3, Group: 1 } });
    expect(order).toEqual([
      'resolve a',
      'delete a',
      'resolve b',
      'delete b',
      'sweep',
      'invalidate',
    ]);
    expect(mockEraseUserData).toHaveBeenCalledWith(
      { userId: 'a'.repeat(24), tenantId: 'acme', checkpointer: undefined },
      { marker: 'a'.repeat(24) },
    );
  });

  it('stops before the sweep when an erasure fails', async () => {
    const { deps, order } = setup();
    mockEraseUserData.mockRejectedValueOnce(new Error('storage down'));

    await expect(purgeTenant('acme', deps)).rejects.toThrow('storage down');
    expect(order).toEqual(['resolve a']);
  });
});

describe('DELETE /api/platform/tenants/:tenantId', () => {
  it('needs the tenant id as confirmation', async () => {
    const { deps } = setup();
    const handler = createTenantPurgeHandler(deps);

    const missing = mockRes();
    await handler(req('acme', {}), missing);
    const wrong = mockRes();
    await handler(req('acme', { confirm: 'other' }), wrong);
    const system = mockRes();
    await handler(req('__SYSTEM__', { confirm: '__SYSTEM__' }), system);

    expect([missing.statusCode, wrong.statusCode, system.statusCode]).toEqual([400, 400, 400]);
    expect(deps.purge.listTenantUserTargets).not.toHaveBeenCalled();
  });

  it('purges and records the operator on the platform chain', async () => {
    const { deps } = setup();
    const res = mockRes();

    await createTenantPurgeHandler(deps)(req('acme', { confirm: 'acme' }), res);

    expect(res.body).toEqual({ users: 2, documents: { Conversation: 3, Group: 1 } });
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.purged',
        tenantId: undefined,
        actor: expect.objectContaining({ type: 'service', id: 'olga' }),
        target: { type: 'tenant', id: 'acme' },
        metadata: { users: 2, documents: 4 },
      }),
    );
  });

  it('answers a generic error when the purge fails', async () => {
    const { deps } = setup();
    mockEraseUserData.mockRejectedValueOnce(new Error('secret detail'));
    const res = mockRes();

    await createTenantPurgeHandler(deps)(req('acme', { confirm: 'acme' }), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
