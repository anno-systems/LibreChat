import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, runAsSystem } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createTestAccountAuditHandler } from './testAccount';

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
  await mongoose.connection.db?.dropDatabase();
});

interface MockRes {
  statusCode: number;
  body?: Record<string, unknown>;
}

function mockRes() {
  const res: MockRes & Record<string, unknown> = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & MockRes;
}

function req(params: Record<string, string>, body: unknown, operator: string | null = 'olga') {
  return {
    params,
    body,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? (operator ?? undefined) : undefined),
  } as unknown as Request;
}

const LOGIN = 'platform-test@acme.invalid';

async function entriesOf(tenantId: string) {
  return runAsSystem(() => mongoose.models.AuditLog.find({ tenantId }).sort({ seq: 1 }).lean());
}

describe('POST /api/platform/tenants/:tenantId/audit/test-account-opened', () => {
  it("records the opening in the tenant's own chain with the operator as actor", async () => {
    const handler = createTestAccountAuditHandler({ recordAuditEntry: methods.recordAuditEntry });
    const res = mockRes();
    await handler(req({ tenantId: 'acme' }, { loginName: LOGIN, created: true }), res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ recorded: true });
    const entries = await entriesOf('acme');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'tenant.test_account_opened',
      category: 'auth',
      outcome: 'success',
      severity: 'warning',
      tenantId: 'acme',
      actor: { type: 'service', id: 'olga' },
      target: { type: 'test_account', id: LOGIN, name: LOGIN },
      metadata: { viaPlatform: true, created: true },
      seq: 1,
    });
    expect(await entriesOf('other')).toHaveLength(0);
  });

  it('names the generic operator when the admin app names none', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const handler = createTestAccountAuditHandler({ recordAuditEntry });
    const res = mockRes();
    await handler(req({ tenantId: 'acme' }, { loginName: LOGIN }, null), res);

    expect(res.statusCode).toBe(201);
    const [entry, options] = recordAuditEntry.mock.calls[0];
    expect(entry.actor).toEqual({
      type: 'service',
      id: 'platform-operator',
      name: 'Platform operator',
    });
    expect(entry.metadata).toEqual({ viaPlatform: true });
    expect(options).toEqual({ failClosed: true });
  });

  it.each([
    ['an invalid tenant', { tenantId: '-x' }, { loginName: LOGIN }],
    ['the system tenant', { tenantId: '__SYSTEM__' }, { loginName: LOGIN }],
    ['no login name', { tenantId: 'acme' }, {}],
    ['a login name that is no address', { tenantId: 'acme' }, { loginName: 'olga' }],
    ['a too long login name', { tenantId: 'acme' }, { loginName: `${'a'.repeat(250)}@x.invalid` }],
    ['a password', { tenantId: 'acme' }, { loginName: LOGIN, password: 'secret' }],
  ])('refuses %s', async (_name, params, body) => {
    const recordAuditEntry = jest.fn();
    const handler = createTestAccountAuditHandler({ recordAuditEntry });
    const res = mockRes();
    await handler(req(params, body), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(recordAuditEntry).not.toHaveBeenCalled();
  });

  it('answers 503 without an audit store, so the opening is not taken as recorded', async () => {
    const handler = createTestAccountAuditHandler({});
    const res = mockRes();
    await handler(req({ tenantId: 'acme' }, { loginName: LOGIN }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'audit_unavailable' });
  });

  it('answers 500 with a fixed code when the write fails, without its message', async () => {
    const recordAuditEntry = jest.fn().mockRejectedValue(new Error('mongo down at 10.0.0.5'));
    const handler = createTestAccountAuditHandler({ recordAuditEntry });
    const res = mockRes();
    await handler(req({ tenantId: 'acme' }, { loginName: LOGIN }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'audit_failed' });
  });
});
