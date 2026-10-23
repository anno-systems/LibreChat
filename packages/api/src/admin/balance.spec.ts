import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { BalanceRecord } from './balance';
import { createAdminBalanceHandlers } from './balance';

const USER_ID = 'a'.repeat(24);

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

function mockRes() {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: Record<string, unknown>) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function mockReq(id: string, body: unknown = {}) {
  return {
    user: { id: 'admin1', role: 'ADMIN', tenantId: 'tenant-a', name: 'Anna' },
    params: { id },
    body,
  } as Partial<ServerRequest> as ServerRequest;
}

function setup(balance: BalanceRecord | null = { tokenCredits: 500, autoRefillEnabled: false }) {
  let stored = balance;
  const deps = {
    getUserById: jest.fn(async (id: string) => (id === USER_ID ? { _id: id } : null)),
    findBalanceByUser: jest.fn(async () => stored),
    upsertBalanceFields: jest.fn(async (_id: string, fields: { tokenCredits: number }) => {
      stored = { autoRefillEnabled: false, ...stored, ...fields };
      return stored;
    }),
    updateBalance: jest.fn(async ({ incrementValue }: { user: string; incrementValue: number }) => {
      stored = {
        autoRefillEnabled: false,
        ...stored,
        tokenCredits: (stored?.tokenCredits ?? 0) + incrementValue,
      };
      return stored;
    }),
    recordAuditEntry: jest.fn().mockResolvedValue(undefined),
  };
  return { deps, handlers: createAdminBalanceHandlers(deps) };
}

describe('admin balance handlers', () => {
  it("reads a user's balance", async () => {
    const { handlers } = setup({ tokenCredits: 500, autoRefillEnabled: true, refillAmount: 100 });
    const res = mockRes();

    await handlers.getUserBalance(mockReq(USER_ID), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      balance: { tokenCredits: 500, autoRefillEnabled: true, refillAmount: 100 },
    });
  });

  it('reports a user without a balance record as null credits', async () => {
    const { handlers } = setup(null);
    const res = mockRes();

    await handlers.getUserBalance(mockReq(USER_ID), res);

    expect(res.body).toEqual({ balance: { tokenCredits: null, autoRefillEnabled: false } });
  });

  it('sets the balance and audits the change with the previous value', async () => {
    const { handlers, deps } = setup();
    const res = mockRes();

    await handlers.setUserBalance(mockReq(USER_ID, { tokenCredits: 2000 }), res);

    expect(res.statusCode).toBe(200);
    expect(deps.upsertBalanceFields).toHaveBeenCalledWith(USER_ID, { tokenCredits: 2000 });
    expect((res.body?.balance as BalanceRecord).tokenCredits).toBe(2000);
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.balance_updated',
        target: { type: 'user', id: USER_ID },
        metadata: { previous: 500, tokenCredits: 2000 },
        tenantId: 'tenant-a',
      }),
    );
  });

  it('answers 404 for a user outside the tenant and 400 for a malformed id', async () => {
    const { handlers, deps } = setup();
    const missing = mockRes();
    const malformed = mockRes();

    await handlers.setUserBalance(mockReq('b'.repeat(24), { tokenCredits: 1 }), missing);
    await handlers.getUserBalance(mockReq('../x'), malformed);

    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
    expect(deps.upsertBalanceFields).not.toHaveBeenCalled();
  });

  it.each([[-1], [1.5], ['100'], [Number.MAX_SAFE_INTEGER], [undefined]])(
    'refuses %p as credits',
    async (tokenCredits) => {
      const { handlers, deps } = setup();
      const res = mockRes();

      await handlers.setUserBalance(mockReq(USER_ID, { tokenCredits }), res);

      expect(res.statusCode).toBe(400);
      expect(deps.upsertBalanceFields).not.toHaveBeenCalled();
    },
  );

  it('adds credits on top of the balance and audits the amount', async () => {
    const { handlers, deps } = setup();
    const res = mockRes();

    await handlers.addUserCredits(mockReq(USER_ID, { amount: 1500 }), res);

    expect(res.statusCode).toBe(200);
    expect(deps.updateBalance).toHaveBeenCalledWith({ user: USER_ID, incrementValue: 1500 });
    expect((res.body?.balance as BalanceRecord).tokenCredits).toBe(2000);
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.balance_updated',
        metadata: { added: 1500, tokenCredits: 2000 },
      }),
    );
  });

  it.each([[0], [-5], [2.5], ['10'], [undefined]])('refuses to add %p credits', async (amount) => {
    const { handlers, deps } = setup();
    const res = mockRes();

    await handlers.addUserCredits(mockReq(USER_ID, { amount }), res);

    expect(res.statusCode).toBe(400);
    expect(deps.updateBalance).not.toHaveBeenCalled();
  });

  it('adds nothing for a user outside the tenant', async () => {
    const { handlers, deps } = setup();
    const res = mockRes();

    await handlers.addUserCredits(mockReq('b'.repeat(24), { amount: 10 }), res);

    expect(res.statusCode).toBe(404);
    expect(deps.updateBalance).not.toHaveBeenCalled();
  });

  it('answers 500 without details when the database fails', async () => {
    const { handlers, deps } = setup();
    deps.findBalanceByUser.mockRejectedValueOnce(new Error('mongo down: secret host'));
    const res = mockRes();

    await handlers.getUserBalance(mockReq(USER_ID), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to read balance' });
  });
});
