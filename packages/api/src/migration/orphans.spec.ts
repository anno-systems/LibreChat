import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage } from '@librechat/data-schemas';
import type { AppConfig, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { TModelsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import {
  createUsableModelCheck,
  createAdminOrphanHandler,
  createOrphanedModelFinder,
  createOperatorOrphanHandler,
} from './orphans';
import { createAdminMigrationHandlers, createOperatorMigrationHandlers } from './handlers';
import { createTenantEndpointLoader, withTenantEndpoints } from '~/platform/catalog';
import { createCatalogModelCheck, createServedTargetCheck } from './guard';
import { createModelMigrationService } from './service';

let mongoServer: MongoMemoryServer;
let db: ReturnType<typeof createMethods>;

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const decrypt = (value: string) => value.replace(/^enc:/, '');

/** librechat.yaml: one endpoint with a fixed list, one that fetches its models. */
const BASE = {
  endpoints: {
    custom: [
      { name: 'Local', baseURL: 'http://local', apiKey: 'k', models: { default: ['llama'] } },
      { name: 'Fetched', baseURL: 'http://f', apiKey: 'k', models: { default: [], fetch: true } },
    ],
  },
  config: {},
} as unknown as AppConfig;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await db.loadModelRedirects();
  await db.upsertPlatformProvider({
    name: 'Mistral',
    label: 'Mistral',
    baseURL: 'https://api.mistral.test/v1',
    apiKey: 'enc:key',
    models: [{ id: 'large' }, { id: 'large-2', label: 'Large 2' }, { id: 'small' }],
  });
  await db.upsertPlatformProvider({
    name: 'Keyless',
    label: 'Keyless',
    baseURL: 'https://keyless.test/v1',
    models: [{ id: 'm' }],
  });
});

/** The tenant-wide config as the app builds it: the base plus the tenant's catalog endpoints. */
function tenantConfig() {
  const loader = createTenantEndpointLoader({
    enabled: true,
    ttlMs: 0,
    getTenantCatalog: db.getTenantCatalog,
    findCatalogProviders: db.findCatalogProviders,
    decrypt,
  });
  return async (tenantId: string) => withTenantEndpoints(BASE, await loader.load(tenantId));
}

function finder() {
  return createOrphanedModelFinder({
    listUsedModels: db.listUsedModels,
    getModelRedirects: db.getModelRedirects,
    getTenantAppConfig: tenantConfig(),
    builtinEndpoints: async () => ['openAI', 'agents'],
  });
}

async function seed(tenantId: string, refs: Array<{ endpoint: string; model: string }>) {
  await inTenant(tenantId, async () => {
    const user = await mongoose.models.User.create({
      email: `ada@${tenantId}.test`,
      provider: 'openid',
    });
    let n = 0;
    for (const ref of refs) {
      n += 1;
      await mongoose.models.Conversation.create({
        conversationId: `c${n}-${tenantId}`,
        user: user._id.toString(),
        ...ref,
      });
    }
    await mongoose.models.Agent.create({
      id: `agent_${tenantId}`,
      name: 'Helper',
      provider: refs[0].endpoint,
      model: refs[0].model,
      author: user._id,
    });
  });
}

interface MockRes {
  statusCode: number;
  body?: Record<string, unknown>;
}

function mockRes() {
  const res: MockRes & Record<string, unknown> = {
    statusCode: 200,
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

async function call<R>(handler: (req: R, res: Response) => Promise<unknown>, req: R) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

const operatorReq = (body: unknown = {}, query: Record<string, string> = {}) =>
  ({ body, query, params: {}, headers: {}, get: () => 'olga' }) as unknown as Request;
const adminReq = (tenantId: string, body: unknown = {}) =>
  ({
    body,
    query: {},
    params: {},
    headers: {},
    get: () => undefined,
    user: { id: 'admin1', role: 'ADMIN', tenantId },
  }) as unknown as ServerRequest;

describe('createUsableModelCheck', () => {
  const usable = createUsableModelCheck(
    {
      endpoints: {
        custom: [
          { name: 'Ollama', baseURL: 'http://o', apiKey: 'k', models: { default: ['llama'] } },
          {
            name: 'Own',
            baseURL: 'http://own',
            apiKey: 'user_provided',
            models: { default: ['a'] },
          },
        ],
        google: { models: ['gemini-pro'] },
      },
    } as unknown as AppConfig,
    ['openAI', 'google'],
  );

  it('reads fixed lists and stays conservative where the list is not known', () => {
    expect(usable({ endpoint: 'ollama', model: 'llama' })).toBe(true);
    expect(usable({ endpoint: 'Ollama', model: 'qwen' })).toBe(false);
    expect(usable({ endpoint: 'Own', model: 'anything' })).toBe(true);
    expect(usable({ endpoint: 'openAI', model: 'anything' })).toBe(true);
    expect(usable({ endpoint: 'google', model: 'gemini-pro' })).toBe(true);
    expect(usable({ endpoint: 'vertexai', model: 'gemini-pro' })).toBe(true);
    expect(usable({ endpoint: 'google', model: 'gemini-old' })).toBe(false);
    expect(usable({ endpoint: 'anthropic', model: 'any' })).toBe(false);
    expect(usable({ endpoint: 'agents', model: 'any' })).toBe(true);
    expect(usable({ endpoint: 'Gone', model: 'any' })).toBe(false);
  });
});

describe('orphaned models', () => {
  beforeEach(async () => {
    await db.setTenantAssignments('acme', {
      byok: true,
      providers: [{ name: 'Mistral', models: ['large-2'] }],
    });
    await db.upsertOwnEndpoint('acme', {
      name: 'AcmeOwn',
      baseURL: 'https://own.acme.test/v1',
      apiKey: 'enc:own',
      models: [{ id: 'own-model' }],
    });
    await db.setTenantAssignments('globex', {
      byok: false,
      providers: [{ name: 'Mistral', models: ['large'] }],
    });
    await seed('acme', [
      { endpoint: 'Mistral', model: 'large' },
      { endpoint: 'Mistral', model: 'large' },
      { endpoint: 'Mistral', model: 'large-2' },
      { endpoint: 'Local', model: 'llama' },
      { endpoint: 'Local', model: 'retired' },
      { endpoint: 'Fetched', model: 'whatever' },
      { endpoint: 'AcmeOwn', model: 'own-model' },
      { endpoint: 'openAI', model: 'gpt-x' },
      { endpoint: 'anthropic', model: 'claude-x' },
      { endpoint: 'agents', model: 'large' },
    ]);
    await seed('globex', [{ endpoint: 'Mistral', model: 'large' }]);
  });

  it('lists what a tenant can no longer use, and nothing it can', async () => {
    const orphans = await finder().find({ tenantId: 'acme' });
    expect(orphans).toEqual([
      {
        tenantId: 'acme',
        endpoint: 'anthropic',
        model: 'claude-x',
        agents: 0,
        conversations: 1,
        redirected: false,
      },
      {
        tenantId: 'acme',
        endpoint: 'Local',
        model: 'retired',
        agents: 0,
        conversations: 1,
        redirected: false,
      },
      {
        tenantId: 'acme',
        endpoint: 'Mistral',
        model: 'large',
        agents: 1,
        conversations: 2,
        redirected: false,
      },
    ]);
  });

  it("answers the tenant admin with the own tenant only; the operator with each tenant's", async () => {
    const admin = await call(createAdminOrphanHandler(finder()), adminReq('globex'));
    expect(admin.body).toEqual({ orphans: [] });

    const all = await call(createOperatorOrphanHandler(finder()), operatorReq());
    const tenants = (all.body?.orphans as Array<{ tenantId: string }>).map((o) => o.tenantId);
    expect(new Set(tenants)).toEqual(new Set(['acme']));

    const one = await call(
      createOperatorOrphanHandler(finder()),
      operatorReq({}, { tenantId: 'globex' }),
    );
    expect(one.body).toEqual({ orphans: [] });
    const bad = await call(
      createOperatorOrphanHandler(finder()),
      operatorReq({}, { tenantId: '../x' }),
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_tenant' });
  });

  it('rescues an orphan through the migration endpoints and refuses a target the tenant cannot use', async () => {
    const audits: RecordAuditEntryInput[] = [];
    const service = createModelMigrationService({
      store: db,
      invalidateConfig: async () => undefined,
      invalidateUser: async () => undefined,
    });
    const getTenantAppConfig = tenantConfig();
    const models = (config: AppConfig): TModelsConfig =>
      Object.fromEntries(
        (config.endpoints?.custom ?? []).map((e) => [
          e.name,
          (e.models?.default ?? []).map((m) => (typeof m === 'string' ? m : m.name)),
        ]),
      );
    const admin = createAdminMigrationHandlers({
      service,
      store: db,
      getTenantAppConfig,
      getModelsConfig: async (req) => models(req.config as AppConfig),
      isServedTarget: createServedTargetCheck({ findPlatformProviders: db.findPlatformProviders }),
      audit: async (_req, event) => {
        audits.push(event as RecordAuditEntryInput);
      },
    });
    const operator = createOperatorMigrationHandlers({
      service,
      store: db,
      isCatalogModel: createCatalogModelCheck({
        getBaseConfig: async () => BASE,
        findPlatformProviders: db.findPlatformProviders,
      }),
      isServedTarget: createServedTargetCheck({ findPlatformProviders: db.findPlatformProviders }),
      unusableTargetTenants: finder().unusableTargetTenants,
      audit: async () => undefined,
      operatorId: () => 'olga',
    });
    const orphan = { endpoint: 'Mistral', model: 'large' };

    const notEnabled = await call(
      admin.migrate,
      adminReq('acme', { from: orphan, to: { endpoint: 'Mistral', model: 'small' } }),
    );
    expect(notEnabled.statusCode).toBe(400);
    expect(notEnabled.body).toEqual({ error: 'target_not_enabled' });

    const keyless = await call(
      operator.migrate,
      operatorReq({ from: orphan, to: { endpoint: 'Keyless', model: 'm' }, tenantIds: ['acme'] }),
    );
    expect(keyless.body).toEqual({ error: 'target_not_served' });

    const unusable = await call(
      operator.migrate,
      operatorReq({
        from: orphan,
        to: { endpoint: 'Mistral', model: 'small' },
        tenantIds: ['acme'],
      }),
    );
    expect(unusable.statusCode).toBe(400);
    expect(unusable.body).toEqual({ error: 'target_not_enabled', tenantIds: ['acme'] });

    const rescued = await call(
      admin.migrate,
      adminReq('acme', { from: orphan, to: { endpoint: 'Mistral', model: 'large-2' } }),
    );
    expect(rescued.statusCode).toBe(200);
    expect(rescued.body?.migration).toMatchObject({
      scope: 'tenant',
      from: orphan,
      counts: expect.objectContaining({ agents: 1, conversations: 2 }),
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'model.migrated',
        target: { type: 'model', id: 'Mistral/large' },
      }),
    ]);

    const left = await finder().find({ tenantId: 'acme' });
    expect(left.map((o) => `${o.endpoint}/${o.model}`)).toEqual([
      'anthropic/claude-x',
      'Local/retired',
    ]);
    const globex = await finder().find({ tenantIds: ['globex'] });
    expect(globex).toEqual([]);
  });

  it('marks an orphan a redirect already covers and carries its label', async () => {
    await db.upsertModelRedirect({
      scope: 'acme',
      from: { endpoint: 'Local', model: 'retired', label: 'Retired' },
      to: { endpoint: 'Local', model: 'llama' },
    });
    const orphans = await finder().find({ tenantId: 'acme' });
    expect(orphans.find((o) => o.model === 'retired')).toMatchObject({
      label: 'Retired',
      redirected: true,
    });
  });
});
