import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, tenantStorage, createModelMigrationMethods } from '@librechat/data-schemas';
import type { AppConfig, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { TModelsConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminMigrationHandlers } from './handlers';
import { createModelMigrationService } from './service';

let mongoServer: MongoMemoryServer;
let store: ReturnType<typeof createModelMigrationMethods>;

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

const LARGE = { endpoint: 'Mistral', model: 'large' };
const LARGE2 = { endpoint: 'Mistral', model: 'large-2' };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  store = createModelMigrationMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await store.loadModelRedirects();
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
    end() {
      return res;
    },
  };
  return res as unknown as Response & MockRes;
}

const adminReq = (body: unknown, tenantId = 'acme') =>
  ({
    params: {},
    body,
    headers: {},
    get: () => undefined,
    user: { id: 'admin1', role: 'ADMIN', tenantId },
  }) as unknown as ServerRequest;

async function call(
  handler: (req: ServerRequest, res: Response) => Promise<unknown>,
  req: ServerRequest,
) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

/** A member of the tenant's group and an outsider, each with an agent and a chat on `large`. */
async function seed(tenantId: string) {
  return inTenant(tenantId, async () => {
    const [member, outsider] = await mongoose.models.User.create([
      { email: `member@${tenantId}.test`, provider: 'local', favorites: [{ ...LARGE }] },
      { email: `outsider@${tenantId}.test`, provider: 'local', favorites: [{ ...LARGE }] },
    ]);
    const group = await mongoose.models.Group.create({
      name: 'Research',
      source: 'local',
      memberIds: [member._id.toString()],
    });
    for (const [key, user] of [
      ['member', member],
      ['outsider', outsider],
    ] as const) {
      await mongoose.models.Agent.create({
        id: `agent_${key}_${tenantId}`,
        name: key,
        provider: LARGE.endpoint,
        model: LARGE.model,
        author: user._id,
      });
      await mongoose.models.Conversation.create({
        conversationId: `c-${key}-${tenantId}`,
        user: user._id.toString(),
        ...LARGE,
      });
    }
    return { groupId: group._id.toString() };
  });
}

const modelOf = (tenantId: string, name: string, filter: Record<string, unknown>) =>
  inTenant(tenantId, async () => {
    const doc = await mongoose.models[name].findOne(filter).lean<{ model?: string }>();
    return doc?.model;
  });

function setup() {
  const audits: RecordAuditEntryInput[] = [];
  const invalidateConfig = jest.fn(async () => undefined);
  const service = createModelMigrationService({
    store,
    invalidateConfig,
    invalidateUser: jest.fn(async () => undefined),
  });
  const tenantModels: Record<string, TModelsConfig> = {
    acme: { Mistral: ['large', 'large-2'] },
    globex: { Mistral: ['large', 'large-2'] },
  };
  const admin = createAdminMigrationHandlers({
    service,
    store,
    getTenantAppConfig: async (tenantId) => ({ tenantId }) as unknown as AppConfig,
    getModelsConfig: async (req) =>
      tenantModels[(req.config as unknown as { tenantId: string }).tenantId] ?? {},
    audit: async (_req, event) => {
      audits.push(event as RecordAuditEntryInput);
    },
  });
  return { admin, audits, invalidateConfig };
}

describe('admin migrations with exceptGroups', () => {
  it('previews and rewrites only what non-members own, without a redirect', async () => {
    const { groupId } = await seed('acme');
    await seed('globex');
    const { admin, audits, invalidateConfig } = setup();

    const preview = await call(
      admin.preview,
      adminReq({ from: LARGE, exceptGroups: [groupId, groupId] }),
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.body?.counts).toEqual({
      agents: 1,
      conversations: 1,
      agentConversations: 0,
      presets: 0,
      modelSpecs: 0,
      favorites: 1,
    });
    const usage = await call(admin.usage, adminReq({ models: [LARGE], exceptGroups: [groupId] }));
    expect(usage.body?.models).toEqual([
      { ...LARGE, agents: 1, conversations: 1, redirected: false },
    ]);

    const res = await call(
      admin.migrate,
      adminReq({ from: LARGE, to: LARGE2, exceptGroups: [groupId] }),
    );
    expect(res.statusCode).toBe(200);
    const migration = res.body?.migration as Record<string, unknown>;
    expect(migration).toMatchObject({
      scope: 'tenant',
      from: LARGE,
      to: LARGE2,
      exceptGroups: [groupId],
      counts: { agents: 1, conversations: 1, favorites: 1, modelSpecs: 0 },
    });
    expect(migration.id).toMatch(/^mm_[0-9a-f-]{36}$/);

    expect(await modelOf('acme', 'Agent', { id: 'agent_outsider_acme' })).toBe('large-2');
    expect(await modelOf('acme', 'Agent', { id: 'agent_member_acme' })).toBe('large');
    expect(await modelOf('acme', 'Conversation', { conversationId: 'c-outsider-acme' })).toBe(
      'large-2',
    );
    expect(await modelOf('acme', 'Conversation', { conversationId: 'c-member-acme' })).toBe(
      'large',
    );
    /* Tenant isolation: the other tenant's outsider keeps the old model. */
    expect(await modelOf('globex', 'Agent', { id: 'agent_outsider_globex' })).toBe('large');

    /* No runtime redirect: the old model stays valid for the group's members. */
    expect(await store.listModelRedirects()).toEqual([]);
    await store.loadModelRedirects();
    expect(store.getModelRedirects()).toEqual([]);
    const redirects = await call(admin.listRedirects, adminReq({}));
    expect(redirects.body).toEqual({ redirects: [] });
    expect(invalidateConfig).not.toHaveBeenCalled();

    expect(audits).toEqual([
      expect.objectContaining({
        action: 'model.migrated',
        tenantId: 'acme',
        metadata: expect.objectContaining({
          migrationId: migration.id,
          exceptGroups: groupId,
          exceptedUsers: 1,
          redirect: false,
          agents: 1,
          conversations: 1,
        }),
      }),
    ]);
  });

  it('refuses unknown groups and groups of another tenant with unknown_group', async () => {
    await seed('acme');
    const globex = await seed('globex');
    const { admin, audits } = setup();
    const missing = new mongoose.Types.ObjectId().toString();

    for (const exceptGroups of [[missing], [globex.groupId]]) {
      const res = await call(admin.migrate, adminReq({ from: LARGE, to: LARGE2, exceptGroups }));
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'unknown_group', groupIds: exceptGroups });
    }
    const preview = await call(admin.preview, adminReq({ from: LARGE, exceptGroups: [missing] }));
    expect(preview.statusCode).toBe(400);
    expect(preview.body?.error).toBe('unknown_group');
    const usage = await call(admin.usage, adminReq({ models: [LARGE], exceptGroups: [missing] }));
    expect(usage.statusCode).toBe(400);

    expect(await modelOf('acme', 'Agent', { id: 'agent_outsider_acme' })).toBe('large');
    expect(await store.listModelRedirects()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('rejects empty or oversized exceptGroups as invalid_migration', async () => {
    const { admin } = setup();
    const many = Array.from({ length: 101 }, () => new mongoose.Types.ObjectId().toString());
    for (const exceptGroups of [[], many]) {
      const res = await call(admin.migrate, adminReq({ from: LARGE, to: LARGE2, exceptGroups }));
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_migration' });
    }
  });

  it('still stores a redirect without exceptGroups', async () => {
    await seed('acme');
    const { admin } = setup();
    const res = await call(admin.migrate, adminReq({ from: LARGE, to: LARGE2 }));
    expect(res.statusCode).toBe(200);
    expect(res.body?.migration).not.toHaveProperty('exceptGroups');
    expect(await modelOf('acme', 'Agent', { id: 'agent_member_acme' })).toBe('large-2');
    const [redirect] = await store.listModelRedirects();
    expect(redirect.redirectId).toBe((res.body?.migration as { id: string }).id);
  });
});
