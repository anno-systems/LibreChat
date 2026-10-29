import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminPasswordResetHandler, USER_NOT_FOUND } from './password';

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
  ended: boolean;
}

function mockRes() {
  const res: MockRes & Record<string, unknown> = {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      res.body = data;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res as unknown as Response & MockRes;
}

const ADMIN_ID = 'f'.repeat(24);

async function addUser(tenantId: string, email: string) {
  return tenantStorage.run({ tenantId }, async () => {
    const user = await mongoose.models.User.create({ email, provider: 'openid', tenantId });
    return String(user._id);
  });
}

/** Runs the handler as an admin of `tenantId`, inside that tenant as the request would. */
async function post(
  tenantId: string,
  id: string,
  recordAuditEntry: typeof methods.recordAuditEntry = methods.recordAuditEntry,
) {
  const handler = createAdminPasswordResetHandler({
    getUserById: methods.getUserById,
    recordAuditEntry,
  });
  const req = {
    user: { id: ADMIN_ID, _id: ADMIN_ID, role: 'ADMIN', tenantId, name: 'Anna' },
    params: { id },
    body: {},
    headers: {},
  } as unknown as ServerRequest;
  const res = mockRes();
  await tenantStorage.run({ tenantId }, () => handler(req, res));
  return res;
}

async function auditEntries() {
  return runAsSystem(() =>
    mongoose.models.AuditLog.find({ action: 'user.password_reset_sent' }).lean<
      Array<{
        tenantId?: string;
        actor: { type: string; id?: string };
        target: { type: string; id: string };
        category: string;
      }>
    >(),
  );
}

describe('POST /api/admin/users/:id/password-reset-events', () => {
  it("records the reset in the tenant's audit chain and answers 204", async () => {
    const userId = await addUser('tenant-a', 'ute@a.example');

    const res = await post('tenant-a', userId);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    const entries = await auditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenantId: 'tenant-a',
      category: 'user',
      actor: { type: 'user', id: ADMIN_ID },
      target: { type: 'user', id: userId },
    });
  });

  it('answers 404 user_not_found for a user of another tenant and records nothing', async () => {
    const otherTenantUser = await addUser('tenant-b', 'bob@b.example');

    const res = await post('tenant-a', otherTenantUser);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: USER_NOT_FOUND });
    expect(await auditEntries()).toHaveLength(0);
  });

  it.each([['b'.repeat(24)], ['not-an-id']])('answers 404 user_not_found for %p', async (id) => {
    const res = await post('tenant-a', id);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: USER_NOT_FOUND });
  });

  it('answers 500 without a 204 when the audit entry cannot be stored', async () => {
    const userId = await addUser('tenant-a', 'ute@a.example');
    const failing = jest.fn().mockRejectedValue(new Error('audit store down'));

    const res = await post('tenant-a', userId, failing);

    expect(failing).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.password_reset_sent' }),
      { failClosed: true },
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('audit store down');
  });
});
