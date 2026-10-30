import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  tenantStorage,
  createModelMigrationMethods,
  createPlatformCatalogMethods,
} from '@librechat/data-schemas';
import type { AppConfig, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { TModelsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createAdminMigrationHandlers, createOperatorMigrationHandlers } from './handlers';
import { createCatalogModelCheck, createModelRemovalGuard } from './guard';
import { createPlatformCatalogHandlers } from '~/platform/handlers';
import { createModelMigrationNoticeHandlers } from './notice';
import { createModelMigrationService } from './service';
import { createAssignedProviderCheck } from './labels';

let mongoServer: MongoMemoryServer;
let store: ReturnType<typeof createModelMigrationMethods>;
let catalog: ReturnType<typeof createPlatformCatalogMethods>;

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  store = createModelMigrationMethods(mongoose);
  catalog = createPlatformCatalogMethods(mongoose);
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

const operatorReq = (body: unknown = {}, params: Record<string, string> = {}, query = {}) =>
  ({
    params,
    body,
    query,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? 'olga' : undefined),
  }) as unknown as Request;

const adminReq = (body: unknown = {}, params: Record<string, string> = {}, tenantId = 'acme') =>
  ({
    params,
    body,
    headers: {},
    get: () => undefined,
    user: { id: 'admin1', role: 'ADMIN', tenantId },
  }) as unknown as ServerRequest;

async function call<R>(handler: (req: R, res: Response) => Promise<unknown>, req: R) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

const LARGE = { endpoint: 'Mistral', model: 'large' };
const LARGE2 = { endpoint: 'Mistral', model: 'large-2' };

async function seedChat(tenantId: string, ref = LARGE) {
  await inTenant(tenantId, async () => {
    const user = await mongoose.models.User.create({
      email: `ada@${tenantId}.test`,
      provider: 'openid',
    });
    await mongoose.models.Agent.create({
      id: `agent_${tenantId}`,
      name: 'Helper',
      provider: ref.endpoint,
      model: ref.model,
      author: user._id,
    });
    await mongoose.models.Conversation.create({
      conversationId: `c-${tenantId}`,
      user: user._id.toString(),
      ...ref,
    });
  });
}

const agentModel = (tenantId: string) =>
  inTenant(tenantId, async () => {
    const agent = await mongoose.models.Agent.findOne({ id: `agent_${tenantId}` }).lean<{
      model: string;
    }>();
    return agent?.model;
  });

function setup(
  platformAgents: Array<{ platformAgentId: string; provider: string; model: string }> = [],
) {
  const audits: RecordAuditEntryInput[] = [];
  const invalidateConfig = jest.fn(async () => undefined);
  const invalidateUser = jest.fn(async () => undefined);
  const service = createModelMigrationService({
    store,
    invalidateConfig,
    invalidateUser,
    labelOf: async (ref) => (ref.model === 'large-2' ? 'Mistral Large 3' : undefined),
    isAssignedProvider: createAssignedProviderCheck({
      findPlatformProviders: catalog.findPlatformProviders,
    }),
  });
  const audit = async (_req: unknown, event: Omit<RecordAuditEntryInput, 'actor' | 'context'>) => {
    audits.push(event as RecordAuditEntryInput);
  };
  const getBaseConfig = async () =>
    ({
      config: { endpoints: { custom: [{ name: 'Azure', models: { default: ['gpt-5'] } }] } },
    }) as unknown as AppConfig;
  const operatorId = () => 'olga';
  const guard = createModelRemovalGuard({
    service,
    listPlatformAgents: async () => platformAgents,
    audit,
    operatorId,
  });
  const operator = createOperatorMigrationHandlers({
    service,
    store,
    isCatalogModel: createCatalogModelCheck({
      getBaseConfig,
      findPlatformProviders: catalog.findPlatformProviders,
    }),
    audit,
    operatorId,
  });
  const tenantModels: Record<string, TModelsConfig> = {
    acme: { Mistral: ['large', 'large-2'], Azure: ['gpt-5'] },
  };
  const admin = createAdminMigrationHandlers({
    service,
    store,
    getTenantAppConfig: async (tenantId) => ({ tenantId }) as unknown as AppConfig,
    getModelsConfig: async (req) =>
      tenantModels[(req.config as unknown as { tenantId: string }).tenantId] ?? {},
    audit,
  });
  const platform = createPlatformCatalogHandlers({
    catalog,
    encrypt: (v) => `enc:${v}`,
    decrypt: (v) => v.replace(/^enc:/, ''),
    getBaseConfig,
    invalidate: jest.fn(async () => undefined),
    modelGuard: guard,
  });
  return { audits, invalidateConfig, invalidateUser, operator, admin, platform };
}

const provider = {
  label: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  apiKey: 'sk-0123456789abcdef',
  models: ['large', 'large-2'],
  location: { type: 'eu' as const },
};

/** Catalog models of the given ids. */
const ids = (models: string[]) => models.map((id) => ({ id }));

describe('operator migrations', () => {
  it('migrates every tenant, records each tenant and the platform, and refuses bad targets', async () => {
    await catalog.upsertPlatformProvider({
      name: 'Mistral',
      ...provider,
      models: ids(provider.models),
      apiKey: 'enc:x',
    });
    await seedChat('acme');
    await seedChat('globex');
    const { operator, audits } = setup();

    const unknown = await call(
      operator.migrate,
      operatorReq({ from: LARGE, to: { endpoint: 'Mistral', model: 'nope' } }),
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toEqual({ error: 'unknown_target' });
    const same = await call(operator.migrate, operatorReq({ from: LARGE2, to: LARGE2 }));
    expect(same.body).toEqual({ error: 'same_model' });

    const preview = await call(operator.preview, operatorReq({ from: LARGE }));
    expect(preview.body?.counts).toMatchObject({ agents: 2, conversations: 2 });

    const res = await call(operator.migrate, operatorReq({ from: LARGE, to: LARGE2 }));
    expect(res.statusCode).toBe(200);
    const migration = res.body?.migration as { id: string; counts: Record<string, number> };
    expect(migration).toMatchObject({ scope: 'platform', from: LARGE, to: LARGE2 });
    expect(migration.counts).toMatchObject({ agents: 2, conversations: 2 });
    expect(migration.id).toMatch(/^mm_/);
    expect(await agentModel('acme')).toBe('large-2');
    expect(await agentModel('globex')).toBe('large-2');
    expect(audits.map((a) => a.tenantId).sort()).toEqual(['acme', 'globex', undefined].sort());
    expect(audits.every((a) => a.action === 'model.migrated')).toBe(true);

    const back = await call(operator.migrate, operatorReq({ from: LARGE2, to: LARGE }));
    expect(back.statusCode).toBe(409);
    expect(back.body).toEqual({ error: 'redirect_cycle' });

    const list = await call(operator.listRedirects, operatorReq());
    expect((list.body?.redirects as unknown[]).length).toBe(1);
    const removed = await call(operator.deleteRedirect, operatorReq({}, { id: migration.id }));
    expect(removed.statusCode).toBe(204);
  });

  it('migrates listed tenants only', async () => {
    await catalog.upsertPlatformProvider({
      name: 'Mistral',
      ...provider,
      models: ids(provider.models),
      apiKey: 'enc:x',
    });
    await seedChat('acme');
    await seedChat('globex');
    const { operator } = setup();
    const res = await call(
      operator.migrate,
      operatorReq({ from: LARGE, to: LARGE2, tenantIds: ['acme'] }),
    );
    expect(res.statusCode).toBe(200);
    expect(await agentModel('acme')).toBe('large-2');
    expect(await agentModel('globex')).toBe('large');
  });
});

describe('model removal guard', () => {
  it('refuses to drop a model in use, unless a successor is named or a redirect exists', async () => {
    const { platform, operator } = setup();
    await call(platform.putProvider, operatorReq(provider, { name: 'Mistral' }));
    await seedChat('acme');

    const refused = await call(
      platform.putProvider,
      operatorReq({ ...provider, apiKey: undefined, models: ['large-2'] }, { name: 'Mistral' }),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: 'model_in_use',
      models: [{ ...LARGE, agents: 1, conversations: 1 }],
    });

    const badSuccessor = await call(
      platform.putProvider,
      operatorReq(
        {
          ...provider,
          apiKey: undefined,
          models: ['large-2'],
          successors: [{ from: LARGE, to: LARGE }],
        },
        { name: 'Mistral' },
      ),
    );
    expect(badSuccessor.body).toEqual({ error: 'invalid_successor' });

    const accepted = await call(
      platform.putProvider,
      operatorReq(
        {
          ...provider,
          apiKey: undefined,
          models: ['large-2'],
          successors: [{ from: LARGE, to: LARGE2 }],
        },
        { name: 'Mistral' },
      ),
    );
    expect(accepted.statusCode).toBe(200);
    expect(await agentModel('acme')).toBe('large-2');
    expect((await catalog.findPlatformProviders(['Mistral']))[0].models).toEqual([
      { id: 'large-2' },
    ]);
    const redirects = await call(operator.listRedirects, operatorReq());
    expect(redirects.body?.redirects).toEqual([
      expect.objectContaining({
        scope: 'platform',
        from: LARGE,
        to: { ...LARGE2, label: 'Mistral Large 3' },
      }),
    ]);

    /* A new chat on the redirected model no longer blocks removing it again. */
    await call(
      platform.putProvider,
      operatorReq(
        { ...provider, apiKey: undefined, models: ['large', 'large-2'] },
        { name: 'Mistral' },
      ),
    );
    await seedChat('globex');
    const covered = await call(
      platform.putProvider,
      operatorReq({ ...provider, apiKey: undefined, models: ['large-2'] }, { name: 'Mistral' }),
    );
    expect(covered.statusCode).toBe(200);
  });

  it('refuses to drop a model a platform agent runs on', async () => {
    const { platform } = setup([
      { platformAgentId: 'platform_support', ...{ provider: 'Mistral', model: 'large' } },
    ]);
    await call(platform.putProvider, operatorReq(provider, { name: 'Mistral' }));
    const refused = await call(
      platform.putProvider,
      operatorReq({ ...provider, apiKey: undefined, models: ['large-2'] }, { name: 'Mistral' }),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: 'model_used_by_platform_agents',
      agents: ['platform_support'],
    });
  });

  it('checks a tenant assignment for that tenant only', async () => {
    const { platform } = setup();
    await call(platform.putProvider, operatorReq(provider, { name: 'Mistral' }));
    const assign = (tenantId: string, models: string[], successors?: unknown) =>
      call(
        platform.putTenantCatalog,
        operatorReq(
          {
            byok: false,
            providers: [{ name: 'Mistral', models }],
            ...(successors ? { successors } : {}),
          },
          { tenantId },
        ),
      );
    await assign('acme', ['large', 'large-2']);
    await assign('globex', ['large', 'large-2']);
    await seedChat('acme');

    expect((await assign('globex', ['large-2'])).statusCode).toBe(200);
    const refused = await assign('acme', ['large-2']);
    expect(refused.statusCode).toBe(409);
    expect(refused.body?.error).toBe('model_in_use');
    const unassigned = await assign(
      'acme',
      ['large-2'],
      [{ from: LARGE, to: { endpoint: 'Other', model: 'x' } }],
    );
    expect(unassigned.body).toEqual({ error: 'invalid_successor' });
    const accepted = await assign('acme', ['large-2'], [{ from: LARGE, to: LARGE2 }]);
    expect(accepted.statusCode).toBe(200);
    expect(await agentModel('acme')).toBe('large-2');
  });
});

describe('operator migration extras', () => {
  it('rewrites to the end of the chain, stores labels and retargets redirects', async () => {
    await catalog.upsertPlatformProvider({
      name: 'Mistral',
      ...provider,
      models: ids(['small', 'large', 'large-2', 'large-3']),
      apiKey: 'enc:x',
    });
    await seedChat('acme', { endpoint: 'Mistral', model: 'small' });
    const { operator } = setup();
    const L3 = { endpoint: 'Mistral', model: 'large-3' };
    await call(operator.migrate, operatorReq({ from: LARGE2, to: L3 }));
    await call(
      operator.migrate,
      operatorReq({ from: { endpoint: 'Mistral', model: 'small' }, to: LARGE }),
    );
    /* small→large exists; large→large-2 continues at large-3, so documents go straight there. */
    const res = await call(operator.migrate, operatorReq({ from: LARGE, to: LARGE2 }));
    const migration = res.body?.migration as Record<string, unknown>;
    expect(migration.to).toEqual({ ...LARGE2, label: 'Mistral Large 3' });
    expect(migration.rewrittenTo).toEqual(L3);
    expect(await agentModel('acme')).toBe('large-3');
    const list = await call(operator.listRedirects, operatorReq());
    const redirects = list.body?.redirects as Array<{
      from: { model: string };
      to: { model: string };
    }>;
    expect(redirects.find((r) => r.from.model === 'small')?.to.model).toBe('large-3');
    expect(redirects.find((r) => r.from.model === 'large')?.to.model).toBe('large-2');
  });

  it('enables the successor for tenants that had the old model, and records it', async () => {
    const { platform, operator, audits, invalidateConfig } = setup();
    await call(platform.putProvider, operatorReq(provider, { name: 'Mistral' }));
    await call(
      platform.putProvider,
      operatorReq({ ...provider, models: ['gpt-5'] }, { name: 'Nebius' }),
    );
    await catalog.setTenantAssignments('acme', {
      byok: false,
      providers: [{ name: 'Mistral', models: ['large'] }],
    });
    await catalog.setTenantAssignments('globex', {
      byok: false,
      providers: [{ name: 'Mistral', models: ['large-2'] }],
    });
    await inTenant('acme', async () => {
      await mongoose.models.Config.create({
        principalType: 'role',
        principalId: '__base__',
        principalModel: 'Role',
        priority: 0,
        overrides: {
          endpoints: {
            custom: [
              { name: 'Mistral', models: { default: ['large'] } },
              { name: 'Nebius', models: { default: [] } },
            ],
          },
        },
      });
    });
    const NEBIUS = { endpoint: 'Nebius', model: 'gpt-5' };
    const res = await call(operator.migrate, operatorReq({ from: LARGE, to: NEBIUS }));
    expect(res.statusCode).toBe(200);
    expect((res.body?.migration as Record<string, unknown>).successorEnabled).toEqual({
      acme: { configs: 1, assignment: true },
    });
    expect((await catalog.getTenantCatalog('acme'))?.providers).toEqual([
      { name: 'Mistral', models: ['large'] },
      { name: 'Nebius', models: ['gpt-5'] },
    ]);
    expect((await catalog.getTenantCatalog('globex'))?.providers).toHaveLength(1);
    expect(invalidateConfig).toHaveBeenCalledWith('acme');
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'model.migrated',
        tenantId: 'acme',
        metadata: expect.objectContaining({ successorConfigs: 1, successorAssigned: true }),
      }),
    );
  });
});

describe('notice handlers', () => {
  it('answers labels and acknowledges an agent notice per user', async () => {
    await seedChat('acme');
    const { operator } = setup();
    await catalog.upsertPlatformProvider({
      name: 'Mistral',
      ...provider,
      models: ids(provider.models),
      apiKey: 'enc:x',
    });
    await call(operator.migrate, operatorReq({ from: LARGE, to: LARGE2 }));
    const notices = createModelMigrationNoticeHandlers(store);
    const userReq = (id: string) =>
      ({
        params: { id: 'agent_acme' },
        user: { id, tenantId: 'acme' },
      }) as unknown as ServerRequest;
    const read = (id: string) => inTenant('acme', () => call(notices.getAgentNotice, userReq(id)));
    const first = await read('u1');
    expect(first.body?.modelMigration).toMatchObject({
      from: { endpoint: 'Mistral', model: 'large' },
      to: { endpoint: 'Mistral', model: 'large-2', label: 'Mistral Large 3' },
    });
    expect(
      (await inTenant('acme', () => call(notices.clearAgentNotice, userReq('u1')))).statusCode,
    ).toBe(204);
    expect((await read('u1')).body).toEqual({ modelMigration: null });
    expect((await read('u2')).body?.modelMigration).not.toBeNull();
    const anonymous = await call(notices.getAgentNotice, {
      params: { id: 'agent_acme' },
    } as unknown as ServerRequest);
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('tenant admin migrations', () => {
  it('needs a target enabled for the tenant and stays within it', async () => {
    await seedChat('acme');
    await seedChat('globex');
    const { admin, audits, invalidateConfig } = setup();

    const usage = await call(admin.usage, adminReq({ models: [LARGE, LARGE2] }));
    expect(usage.body?.models).toEqual([
      { ...LARGE, agents: 1, conversations: 1, redirected: false },
      { ...LARGE2, agents: 0, conversations: 0, redirected: false },
    ]);

    const disabled = await call(
      admin.migrate,
      adminReq({ from: LARGE, to: { endpoint: 'Mistral', model: 'small' } }),
    );
    expect(disabled.statusCode).toBe(400);
    expect(disabled.body).toEqual({ error: 'target_not_enabled' });

    const preview = await call(admin.preview, adminReq({ from: LARGE }));
    expect(preview.body?.counts).toMatchObject({ agents: 1, conversations: 1 });

    const res = await call(
      admin.migrate,
      adminReq({ from: LARGE, to: { endpoint: 'Azure', model: 'gpt-5' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body?.migration).toMatchObject({ scope: 'tenant', counts: { agents: 1 } });
    expect(await agentModel('acme')).toBe('gpt-5');
    expect(await agentModel('globex')).toBe('large');
    expect(audits).toEqual([
      expect.objectContaining({ action: 'model.migrated', tenantId: 'acme' }),
    ]);
    expect(invalidateConfig).not.toHaveBeenCalled();

    const after = await call(admin.usage, adminReq({ models: [LARGE] }));
    expect(after.body?.models).toEqual([
      { ...LARGE, agents: 0, conversations: 0, redirected: true },
    ]);

    const list = await call(admin.listRedirects, adminReq());
    const [own] = list.body?.redirects as Array<{ id: string; scope: string }>;
    expect(own.scope).toBe('tenant');
    const otherTenant = await call(admin.deleteRedirect, adminReq({}, { id: own.id }, 'globex'));
    expect(otherTenant.statusCode).toBe(404);
    const removed = await call(admin.deleteRedirect, adminReq({}, { id: own.id }));
    expect(removed.statusCode).toBe(204);
    expect(audits[1]).toMatchObject({ action: 'model.redirect_deleted' });
  });

  it('lists operator redirects for the tenant without their tenant lists', async () => {
    await store.upsertModelRedirect({
      scope: 'platform',
      tenantIds: ['acme', 'globex'],
      from: LARGE,
      to: LARGE2,
    });
    await store.upsertModelRedirect({
      scope: 'platform',
      tenantIds: ['globex'],
      from: LARGE2,
      to: LARGE,
    });
    const { admin } = setup();
    const list = await call(admin.listRedirects, adminReq());
    expect(list.body?.redirects).toEqual([
      expect.not.objectContaining({ tenantIds: expect.anything() }),
    ]);
  });
});
