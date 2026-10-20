import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTenantPurgeMethods } from './tenantPurge';
import { tenantStorage } from '../config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createTenantPurgeMethods>;

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

async function seed(tenantId: string) {
  await inTenant(tenantId, async () => {
    const user = await mongoose.models.User.create({
      email: `ada@${tenantId}.test`,
      name: 'Ada',
      provider: 'openid',
      role: 'ADMIN',
    });
    await mongoose.models.Conversation.create({
      conversationId: `c-${tenantId}`,
      user: user._id.toString(),
      endpoint: 'agents',
    });
    await mongoose.models.Group.create({ name: 'Sales', source: 'local', memberIds: [] });
  });
}

const count = (model: string, tenantId: string) =>
  inTenant(tenantId, async () => await mongoose.models[model].countDocuments({}));

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createTenantPurgeMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await seed('tenant-a');
  await seed('tenant-b');
});

describe('tenant purge methods', () => {
  it("lists the tenant's users for the erasure cascade", async () => {
    const users = await methods.listTenantUserTargets('tenant-a');

    expect(users).toEqual([
      expect.objectContaining({
        role: 'ADMIN',
        tenantId: 'tenant-a',
        profile: expect.objectContaining({ email: 'ada@tenant-a.test', provider: 'openid' }),
      }),
    ]);
  });

  it("deletes every document of the tenant and nothing of another tenant's", async () => {
    const counts = await methods.purgeTenantDocuments('tenant-a');

    expect(counts).toMatchObject({ User: 1, Conversation: 1, Group: 1 });
    for (const model of ['User', 'Conversation', 'Group']) {
      expect(await count(model, 'tenant-a')).toBe(0);
      expect(await count(model, 'tenant-b')).toBe(1);
    }
    expect(await methods.purgeTenantDocuments('tenant-a')).toEqual({});
  });

  it('keeps the append-only audit log', async () => {
    await inTenant('tenant-a', async () => {
      await mongoose.models.AuditLog.collection.insertOne({ tenantId: 'tenant-a', action: 'x' });
    });

    const counts = await methods.purgeTenantDocuments('tenant-a');

    expect(counts).not.toHaveProperty('AuditLog');
    expect(await mongoose.models.AuditLog.collection.countDocuments({ tenantId: 'tenant-a' })).toBe(
      1,
    );
  });

  it('refuses an empty, malformed or system tenant', async () => {
    for (const tenantId of ['', '__SYSTEM__', '../x', ' tenant-a']) {
      await expect(methods.purgeTenantDocuments(tenantId)).rejects.toThrow(/valid tenant id/);
      await expect(methods.listTenantUserTargets(tenantId)).rejects.toThrow(/valid tenant id/);
    }
    expect(await count('User', 'tenant-a')).toBe(1);
  });
});
