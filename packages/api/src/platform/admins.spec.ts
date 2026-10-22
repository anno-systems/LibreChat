import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AUTH_USER_DOC_BY_ID_PREFIX, SystemRoles } from 'librechat-data-provider';
import { createMethods, createModels, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createTenantAdminHandler } from './admins';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
const cache = new Map<string, unknown>();
const previousCacheMode = process.env.AUTH_USER_CACHE_MODE;

beforeAll(async () => {
  process.env.AUTH_USER_CACHE_MODE = 'on';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose, {
    getCache: () =>
      ({
        get: async (key: string) => cache.get(key),
        set: async (key: string, value: unknown) => void cache.set(key, value),
        delete: async (key: string) => cache.delete(key),
      }) as never,
  });
});

afterAll(async () => {
  process.env.AUTH_USER_CACHE_MODE = previousCacheMode;
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  cache.clear();
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

function req(params: Record<string, string>, body: unknown) {
  return {
    params,
    body,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? 'olga' : undefined),
  } as unknown as Request;
}

async function addUser(tenantId: string, openidId: string, role: string) {
  return tenantStorage.run({ tenantId }, async () => {
    const user = await mongoose.models.User.create({
      email: `${openidId}@${tenantId}.example`,
      provider: 'openid',
      openidId,
      role,
      tenantId,
    });
    return String(user._id);
  });
}

async function roleOf(userId: string) {
  return runAsSystem(async () => {
    const user = await mongoose.models.User.findById(userId).lean<{ role?: string }>();
    return user?.role;
  });
}

function setup(recordAuditEntry = jest.fn().mockResolvedValue(undefined), failClosed = false) {
  const handler = createTenantAdminHandler({
    findUser: methods.findUser,
    updateUser: methods.updateUser,
    recordAuditEntry,
    auditFailClosed: failClosed,
  });
  const put = async (params: Record<string, string>, body: unknown) => {
    const res = mockRes();
    await handler(req(params, body), res);
    return res;
  };
  return { put, recordAuditEntry };
}

describe('PUT /api/platform/tenants/:tenantId/admins/:subject', () => {
  it('promotes the tenant user, evicts the cached auth document and audits in the tenant', async () => {
    const userId = await addUser('tenant-a', 'sub-1', SystemRoles.USER);
    cache.set(`${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`, ['doc-key']);
    cache.set('doc-key', { _id: userId, role: SystemRoles.USER });
    const { put, recordAuditEntry } = setup();

    const res = await put(
      { tenantId: 'tenant-a', subject: 'sub-1' },
      { admin: true, email: 'anna@a.example' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ found: true, role: SystemRoles.ADMIN });
    expect(await roleOf(userId)).toBe(SystemRoles.ADMIN);
    expect(cache.has('doc-key')).toBe(false);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.member_added',
        severity: 'critical',
        tenantId: 'tenant-a',
        actor: { type: 'service', id: 'olga', name: 'olga' },
        target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
        metadata: {
          subject: 'sub-1',
          userId,
          previousRole: SystemRoles.USER,
          email: 'anna@a.example',
          changed: true,
          viaPlatform: true,
        },
      }),
    );
  });

  it('demotes an admin to USER and leaves other roles alone', async () => {
    const adminId = await addUser('tenant-a', 'sub-admin', SystemRoles.ADMIN);
    const customId = await addUser('tenant-a', 'sub-custom', 'EDITOR');
    const { put, recordAuditEntry } = setup();

    const demoted = await put({ tenantId: 'tenant-a', subject: 'sub-admin' }, { admin: false });
    const untouched = await put({ tenantId: 'tenant-a', subject: 'sub-custom' }, { admin: false });

    expect(demoted.body).toEqual({ found: true, role: SystemRoles.USER });
    expect(untouched.body).toEqual({ found: true, role: 'EDITOR' });
    expect(await roleOf(adminId)).toBe(SystemRoles.USER);
    expect(await roleOf(customId)).toBe('EDITOR');
    expect(recordAuditEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'role.member_removed',
        metadata: expect.objectContaining({ previousRole: 'EDITOR', changed: false }),
      }),
    );
  });

  it('keeps an admin an admin when promoted again', async () => {
    const adminId = await addUser('tenant-a', 'sub-admin', SystemRoles.ADMIN);
    const { put } = setup();

    const res = await put({ tenantId: 'tenant-a', subject: 'sub-admin' }, { admin: true });

    expect(res.body).toEqual({ found: true, role: SystemRoles.ADMIN });
    expect(await roleOf(adminId)).toBe(SystemRoles.ADMIN);
  });

  it('changes nothing for a user who never signed in, and still audits', async () => {
    const { put, recordAuditEntry } = setup();

    const res = await put({ tenantId: 'tenant-a', subject: 'sub-new' }, { admin: true });

    expect(res.body).toEqual({ found: false, role: null });
    expect(await runAsSystem(() => mongoose.models.User.countDocuments({}))).toBe(0);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'role.member_added',
        tenantId: 'tenant-a',
        metadata: { subject: 'sub-new', changed: false, viaPlatform: true },
      }),
    );
  });

  it('never touches a user with the same subject in another tenant', async () => {
    const otherId = await addUser('tenant-b', 'sub-1', SystemRoles.USER);
    const { put } = setup();

    const missing = await put({ tenantId: 'tenant-a', subject: 'sub-1' }, { admin: true });
    const ownId = await addUser('tenant-a', 'sub-1', SystemRoles.USER);
    const promoted = await put({ tenantId: 'tenant-a', subject: 'sub-1' }, { admin: true });

    expect(missing.body).toEqual({ found: false, role: null });
    expect(promoted.body).toEqual({ found: true, role: SystemRoles.ADMIN });
    expect(await roleOf(ownId)).toBe(SystemRoles.ADMIN);
    expect(await roleOf(otherId)).toBe(SystemRoles.USER);
  });

  it('refuses invalid tenants, subjects and bodies', async () => {
    const userId = await addUser('tenant-a', 'sub-1', SystemRoles.USER);
    const { put, recordAuditEntry } = setup();

    const cases: Array<[Record<string, string>, unknown]> = [
      [{ tenantId: '__SYSTEM__', subject: 'sub-1' }, { admin: true }],
      [{ tenantId: 'bad/tenant', subject: 'sub-1' }, { admin: true }],
      [{ tenantId: 'tenant-a', subject: 'sub.1' }, { admin: true }],
      [{ tenantId: 'tenant-a', subject: 'x'.repeat(129) }, { admin: true }],
      [{ tenantId: 'tenant-a', subject: 'sub-1' }, { admin: 'yes' }],
      [{ tenantId: 'tenant-a', subject: 'sub-1' }, {}],
      [
        { tenantId: 'tenant-a', subject: 'sub-1' },
        { admin: true, email: 'not-an-email' },
      ],
      [
        { tenantId: 'tenant-a', subject: 'sub-1' },
        { admin: true, role: 'ADMIN' },
      ],
    ];
    for (const [params, body] of cases) {
      const res = await put(params, body);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
    }
    expect(await roleOf(userId)).toBe(SystemRoles.USER);
    expect(recordAuditEntry).not.toHaveBeenCalled();
  });

  it('answers 500 when a fail-closed audit write fails', async () => {
    await addUser('tenant-a', 'sub-1', SystemRoles.USER);
    const { put } = setup(jest.fn().mockRejectedValue(new Error('audit down')), true);

    const res = await put({ tenantId: 'tenant-a', subject: 'sub-1' }, { admin: true });

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('audit down');
  });
});
