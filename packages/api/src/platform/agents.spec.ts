import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { AppConfig, PlatformAgentInput } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createPlatformAgentLock, markPlatformAgents, platformAgentListFilter } from './agentLock';
import { createPlatformAgentService, withRunEndpoint } from './agents';
import { createPlatformAgentHandlers } from './agentApi';
import { validateAgentModel } from '~/agents/validation';
import { getCustomEndpointConfig } from '~/app/config';
import { getProviderConfig } from '~/endpoints';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

const KEY = 'sk-operator-0123456789abcd';
const decrypt = (value: string) => value.replace(/^enc:/, '');

const support: PlatformAgentInput = {
  platformAgentId: 'platform_support',
  name: 'Support',
  description: 'Answers questions about the platform',
  instructions: 'Be helpful.',
  conversation_starters: ['Is there an outage?'],
  tools: ['platform_status_mcp_support', 'sys__server__sys_mcp_support'],
  provider: 'Mistral Platform',
  model: 'mistral-small-latest',
  tenants: 'all',
};

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
  await runAsSystem(async () => await methods.seedDefaultRoles());
  await methods.upsertPlatformProvider({
    name: 'Mistral Platform',
    label: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    apiKey: `enc:${KEY}`,
    models: [{ id: 'mistral-small-latest' }, { id: 'mistral-large-latest' }],
  });
});

function service() {
  return createPlatformAgentService({
    store: methods,
    findPlatformProviders: methods.findPlatformProviders,
    decrypt,
  });
}

const tenantsWithCopies = async () =>
  (await methods.listPlatformAgentCopies('platform_support')).map((c) => c.tenantId).sort();

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

const operatorReq = (params: Record<string, string>, body: unknown = {}) =>
  ({
    params,
    body,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? 'olga' : undefined),
  }) as unknown as Request;

const adminReq = (params: Record<string, string>, body: unknown = {}, tenantId = 'acme') =>
  ({
    params,
    body,
    headers: {},
    get: () => undefined,
    user: { id: 'admin1', role: 'ADMIN', tenantId, name: 'Anna' },
  }) as unknown as ServerRequest;

function handlers() {
  const svc = service();
  const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
  return {
    svc,
    recordAuditEntry,
    ...createPlatformAgentHandlers({
      service: svc,
      store: methods,
      findPlatformProviders: methods.findPlatformProviders,
      listPlatformMcpTools: () => methods.listPlatformMcpTools(),
      recordAuditEntry,
    }),
  };
}

describe('copies', () => {
  it('writes copies for listed tenants and removes them when untargeted or switched off', async () => {
    const svc = service();
    await methods.upsertPlatformAgent({ ...support, tenants: ['acme', 'beta'] });
    expect(await svc.sync('platform_support')).toEqual({ written: 2, removed: 0 });
    expect(await tenantsWithCopies()).toEqual(['acme', 'beta']);

    await methods.upsertPlatformAgent({ ...support, tenants: ['beta', 'gamma'] });
    await methods.setPlatformAgentEnabled('platform_support', 'gamma', false);
    expect(await svc.sync('platform_support')).toEqual({ written: 1, removed: 1 });
    expect(await tenantsWithCopies()).toEqual(['beta']);

    await methods.deletePlatformAgent('platform_support');
    await svc.sync('platform_support');
    expect(await tenantsWithCopies()).toEqual([]);
  });

  it('gives a tenant its copies when its agents are listed, once per TTL', async () => {
    let now = 0;
    const listPlatformAgents = jest.spyOn(methods, 'listPlatformAgents');
    const svc = createPlatformAgentService({
      store: methods,
      findPlatformProviders: methods.findPlatformProviders,
      decrypt,
      now: () => now,
    });
    await methods.upsertPlatformAgent(support);

    await svc.ensureTenant('acme');
    await svc.ensureTenant('acme');
    expect(await tenantsWithCopies()).toEqual(['acme']);
    expect(listPlatformAgents).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await methods.upsertPlatformAgent({ ...support, name: 'Help desk' });
    now = 60_000;
    await svc.ensureTenant('acme');
    const [copy] = await tenantStorage.run({ tenantId: 'acme' }, async () =>
      mongoose.models.Agent.find({ id: 'agent_platform_support' }).lean<{ name: string }[]>(),
    );
    expect(copy.name).toBe('Help desk');
    listPlatformAgents.mockRestore();
  });

  it('logs a failed tenant sync instead of failing the caller', async () => {
    const svc = createPlatformAgentService({
      store: {
        ...methods,
        listPlatformAgents: jest.fn().mockRejectedValue(new Error('db down')),
      },
      findPlatformProviders: methods.findPlatformProviders,
      decrypt,
    });
    await expect(svc.ensureTenant('acme')).resolves.toBeUndefined();
  });
});

describe('operator API', () => {
  it('saves a definition on a catalog model, writes its copies and audits it', async () => {
    const { putAgent, listAgents, recordAuditEntry } = handlers();
    const res = mockRes();
    await putAgent(
      operatorReq(
        { id: 'platform_support' },
        { ...support, platformAgentId: undefined, tenants: ['acme'] },
      ),
      res,
    );
    expect(res.statusCode).toBe(400);

    const { platformAgentId: _id, ...body } = support;
    const created = mockRes();
    await putAgent(
      operatorReq({ id: 'platform_support' }, { ...body, tenants: ['acme'] }),
      created,
    );
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      synced: true,
      agent: { agentId: 'agent_platform_support' },
    });
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.agent_updated',
        actor: expect.objectContaining({ type: 'service', id: 'olga' }),
        target: { type: 'agent', id: 'platform_support', name: 'Support' },
      }),
    );

    const listed = mockRes();
    await listAgents(operatorReq({}), listed);
    expect(listed.body).toMatchObject({ agents: [{ activeTenants: ['acme'], tenants: ['acme'] }] });
  });

  it("lists the platform MCP servers' tools by agent tool id", async () => {
    const { listTools } = handlers();
    await methods.setPlatformMcpTools('support', [
      { name: 'create_ticket', title: 'Create ticket', readOnly: false },
      { name: 'platform_status', readOnly: true, description: 'Outages' },
    ]);

    const res = mockRes();
    await listTools(operatorReq({}), res);

    expect(res.body).toEqual({
      servers: [
        {
          name: 'support',
          marker: 'sys__server__sys_mcp_support',
          tools: [
            { id: 'create_ticket_mcp_support', name: 'Create ticket' },
            { id: 'platform_status_mcp_support', name: 'platform_status', description: 'Outages' },
          ],
        },
      ],
    });
  });

  it('refuses a model outside the catalog and an invalid id', async () => {
    const { putAgent } = handlers();
    const { platformAgentId: _id, ...body } = support;
    const unknown = mockRes();
    await putAgent(operatorReq({ id: 'platform_support' }, { ...body, model: 'gpt-4o' }), unknown);
    expect(unknown).toMatchObject({
      statusCode: 400,
      body: { error: 'unknown_provider_or_model' },
    });

    const badId = mockRes();
    await putAgent(operatorReq({ id: 'agent_support' }, body), badId);
    expect(badId).toMatchObject({ statusCode: 400, body: { error: 'invalid_platform_agent' } });
  });

  it('deletes a definition with every copy', async () => {
    const { deleteAgent, svc } = handlers();
    await methods.upsertPlatformAgent({ ...support, tenants: ['acme'] });
    await svc.sync('platform_support');

    const res = mockRes();
    await deleteAgent(operatorReq({ id: 'platform_support' }), res);
    expect(res.statusCode).toBe(204);
    expect(await tenantsWithCopies()).toEqual([]);

    const again = mockRes();
    await deleteAgent(operatorReq({ id: 'platform_support' }), again);
    expect(again.statusCode).toBe(404);
  });
});

describe('tenant admin API', () => {
  it("lists the tenant's platform agents and switches one off and on for the tenant only", async () => {
    const { listTenantAgents, putTenantAgent, recordAuditEntry } = handlers();
    await methods.upsertPlatformAgent(support);

    const listed = mockRes();
    await listTenantAgents(adminReq({}), listed);
    expect(listed.body).toEqual({
      agents: [expect.objectContaining({ platformAgentId: 'platform_support', enabled: true })],
    });
    expect(listed.body?.agents).toEqual([
      expect.not.objectContaining({ instructions: expect.anything() }),
    ]);
    expect(await tenantsWithCopies()).toEqual(['acme']);

    const off = mockRes();
    await putTenantAgent(adminReq({ id: 'platform_support' }, { enabled: false }), off);
    expect(off.body).toMatchObject({ agent: { enabled: false } });
    expect(await tenantsWithCopies()).toEqual([]);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.agent_toggled',
        tenantId: 'acme',
        metadata: { enabled: false },
      }),
    );

    const otherTenant = mockRes();
    await listTenantAgents(adminReq({}, {}, 'beta'), otherTenant);
    expect(otherTenant.body).toMatchObject({ agents: [{ enabled: true }] });

    const on = mockRes();
    await putTenantAgent(adminReq({ id: 'platform_support' }, { enabled: true }), on);
    expect(await tenantsWithCopies()).toEqual(['acme', 'beta']);
  });

  it('answers 404 for an agent not meant for the tenant and 400 for anything but enabled', async () => {
    const { putTenantAgent } = handlers();
    await methods.upsertPlatformAgent({ ...support, tenants: ['beta'] });

    const foreign = mockRes();
    await putTenantAgent(adminReq({ id: 'platform_support' }, { enabled: false }), foreign);
    expect(foreign).toMatchObject({ statusCode: 404, body: { error: 'not_found' } });

    const extra = mockRes();
    await putTenantAgent(
      adminReq({ id: 'platform_support' }, { enabled: true, name: 'Mine' }, 'beta'),
      extra,
    );
    expect(extra.statusCode).toBe(400);
  });
});

describe('lock', () => {
  const run = async (
    middleware: ReturnType<ReturnType<typeof createPlatformAgentLock>['byAgentId']>,
    req: unknown,
  ) => {
    const res = mockRes();
    const next = jest.fn();
    await tenantStorage.run({ tenantId: 'acme' }, async () =>
      middleware(req as Request, res, next),
    );
    return { res, next };
  };

  it('refuses changes to a copy and passes every other agent, whoever calls', async () => {
    const svc = service();
    await methods.upsertPlatformAgent(support);
    await svc.ensureTenant('acme');
    const lock = createPlatformAgentLock({
      findAgent: (filter) => methods.getAgent(filter, { platformAgentId: 1 }),
    });

    const copy = await run(lock.byAgentId('id'), { params: { id: 'agent_platform_support' } });
    expect(copy.next).not.toHaveBeenCalled();
    expect(copy.res).toMatchObject({ statusCode: 403, body: { error: 'platform_agent_locked' } });

    const management = await run(lock.byAgentId('id', { management: true }), {
      params: { id: 'agent_platform_support' },
    });
    expect(management.res.body).toMatchObject({ error: { code: 'platform_agent_locked' } });

    const other = await run(lock.byAgentId('id'), { params: { id: 'agent_someone' } });
    expect(other.next).toHaveBeenCalled();

    const [stored] = await tenantStorage.run({ tenantId: 'acme' }, async () =>
      mongoose.models.Agent.find({ id: 'agent_platform_support' }).lean<{ _id: unknown }[]>(),
    );
    const sharing = await run(lock.bySharedResource(), {
      params: { resourceType: 'agent', resourceId: String(stored._id) },
    });
    expect(sharing.res.statusCode).toBe(403);
    const prompt = await run(lock.bySharedResource(), {
      params: { resourceType: 'promptGroup', resourceId: String(stored._id) },
    });
    expect(prompt.next).toHaveBeenCalled();
  });

  it('marks copies as not editable and keeps them out of lists of agents to edit', () => {
    const rows = markPlatformAgents([
      { id: 'agent_platform_support', platformAgentId: 'platform_support', isEditable: true },
      { id: 'agent_own', isEditable: true },
    ]);
    expect(rows.map((row) => row.isEditable)).toEqual([false, true]);
    expect(platformAgentListFilter(1)).toEqual({});
    expect(platformAgentListFilter(3)).toEqual({ platformAgentId: { $exists: false } });
  });
});

describe('a run of a platform agent', () => {
  const tenantConfig = {
    endpoints: {
      custom: [
        {
          name: 'Tenant LLM',
          baseURL: 'https://llm.acme.test',
          apiKey: 'k',
          models: { default: ['m'] },
        },
      ],
    },
  } as unknown as AppConfig;
  const tenantModels = { 'Tenant LLM': ['m'] };

  it("adds the catalog provider for this run only, so the tenant's model lists stay", async () => {
    await methods.upsertPlatformAgent(support);
    const agent = {
      platformAgentId: 'platform_support',
      provider: 'Mistral Platform',
      model: 'mistral-small-latest',
    };

    const runConfig = await service().prepareRun({
      agent,
      tenantId: 'acme',
      appConfig: tenantConfig,
      modelsConfig: tenantModels,
    });

    expect(tenantConfig.endpoints?.custom).toHaveLength(1);
    expect(tenantModels).toEqual({ 'Tenant LLM': ['m'] });
    expect(
      getCustomEndpointConfig({ endpoint: 'Mistral Platform', appConfig: runConfig.appConfig }),
    ).toMatchObject({ baseURL: 'https://api.mistral.ai/v1', apiKey: KEY, tenantId: 'acme' });
    expect(
      getProviderConfig({ provider: 'Mistral Platform', appConfig: runConfig.appConfig })
        .customEndpointConfig,
    ).toBeDefined();
    expect(() =>
      getProviderConfig({ provider: 'Mistral Platform', appConfig: tenantConfig }),
    ).toThrow('Provider Mistral Platform not supported');
    const validation = await validateAgentModel({
      req: {} as never,
      res: {} as never,
      agent: { id: 'agent_platform_support', ...agent } as never,
      modelsConfig: runConfig.modelsConfig!,
      logViolation: jest.fn(),
    });
    expect(validation.isValid).toBe(true);
  });

  it('changes nothing for other agents, stale copies, untargeted or switched-off tenants', async () => {
    await methods.upsertPlatformAgent({ ...support, tenants: ['acme', 'beta'] });
    await methods.setPlatformAgentEnabled('platform_support', 'beta', false);
    const svc = service();
    const prepare = (agent: Record<string, unknown>, tenantId = 'acme') =>
      svc.prepareRun({ agent, tenantId, appConfig: tenantConfig, modelsConfig: tenantModels });
    const copy = {
      platformAgentId: 'platform_support',
      provider: 'Mistral Platform',
      model: 'mistral-small-latest',
    };

    for (const result of [
      await prepare({ provider: 'Tenant LLM', model: 'm' }),
      await prepare({ ...copy, model: 'mistral-large-latest' }),
      await prepare({ ...copy, provider: 'Tenant LLM' }),
      await prepare(copy, 'gamma'),
      await prepare(copy, 'beta'),
    ]) {
      expect(result.appConfig).toBe(tenantConfig);
      expect(result.modelsConfig).toBe(tenantModels);
    }
  });

  it("keeps the tenant's own endpoint when it is assigned the provider", () => {
    const assigned = {
      endpoints: { custom: [{ name: 'Mistral Platform', baseURL: 'https://api.mistral.ai/v1' }] },
    } as unknown as AppConfig;
    expect(withRunEndpoint(assigned, { name: 'Mistral Platform' } as never)).toBe(assigned);
  });

  it("bills the run to the tenant at the provider's rates with the platform markup", async () => {
    await methods.upsertPlatformAgent(support);
    await methods.setPlatformPricing({ scope: 'default', tokenMarkup: 0.15 });
    await methods.setPlatformPricing({ scope: 'beta', tokenMarkup: 0 });
    const runConfig = await service().prepareRun({
      agent: {
        platformAgentId: 'platform_support',
        provider: 'Mistral Platform',
        model: 'mistral-small-latest',
      },
      tenantId: 'acme',
      appConfig: tenantConfig,
      modelsConfig: tenantModels,
    });
    const { getOptions } = getProviderConfig({
      provider: 'Mistral Platform',
      appConfig: runConfig.appConfig,
    });
    const options = await getOptions({
      runtime: {
        appConfig: runConfig.appConfig,
        user: { id: 'u1', tenantId: 'acme' } as never,
        requestBody: {},
      },
      endpoint: 'Mistral Platform',
      model_parameters: { model: 'mistral-small-latest' },
      db: { getUserKeyValues: jest.fn() } as never,
    });
    /** No token config of its own: the catalog provider is priced like the tenant's endpoints. */
    expect(options.endpointTokenConfig).toBeUndefined();

    const user = new mongoose.Types.ObjectId();
    const charge = (tenantId: string) =>
      tenantStorage.run({ tenantId }, async () => {
        await methods.createTransaction({
          user,
          tokenType: 'prompt',
          rawAmount: -1000,
          model: 'mistral-small-latest',
          endpointTokenConfig: options.endpointTokenConfig,
          context: 'message',
        });
        return mongoose.models.Transaction.findOne({ tenantId })
          .sort({ _id: -1 })
          .lean<{ rate: number; tenantId: string }>();
      });

    const billed = await charge('acme');
    const unmarked = await charge('beta');
    expect(billed?.tenantId).toBe('acme');
    expect(billed!.rate).toBeCloseTo(unmarked!.rate * 1.15);
  });
});
