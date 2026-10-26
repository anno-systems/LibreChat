import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPlatformCatalogMethods } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createPlatformCatalogHandlers, requirePlatformToken } from './handlers';

const TOKEN = 'p'.repeat(40);
const KEY = 'sk-operator-0123456789abcd';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPlatformCatalogMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  methods = createPlatformCatalogMethods(mongoose);
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
    end() {
      return res;
    },
  };
  return res as unknown as Response & MockRes;
}

function operatorReq(params: Record<string, string>, body: unknown = {}) {
  return {
    params,
    body,
    headers: {},
    get: (name: string) => (name === 'X-Platform-Operator' ? 'olga' : undefined),
  } as unknown as Request;
}

function adminReq(params: Record<string, string>, body: unknown = {}, tenantId = 'tenant-a') {
  return {
    params,
    body,
    headers: {},
    get: () => undefined,
    user: { id: 'admin1', role: 'ADMIN', tenantId, name: 'Anna' },
  } as unknown as ServerRequest;
}

function setup() {
  const deps = {
    catalog: methods,
    encrypt: (value: string) => `enc:${value}`,
    decrypt: (value: string) => value.replace(/^enc:/, ''),
    getBaseConfig: async () =>
      ({ config: { endpoints: { custom: [{ name: 'Mistral EU' }] } } }) as unknown as AppConfig,
    isAllowedTenantURL: jest.fn(async (url: string) => !url.includes('169.254')),
    invalidate: jest.fn(async () => undefined),
    recordAuditEntry: jest.fn().mockResolvedValue(undefined),
  };
  return { deps, handlers: createPlatformCatalogHandlers(deps) };
}

const provider = {
  label: 'Mistral',
  baseURL: 'https://api.mistral.ai/v1',
  apiKey: KEY,
  models: ['small', 'large'],
  region: 'EU (Paris)',
  country: 'fr',
};

async function call(
  handler: (req: never, res: Response) => Promise<unknown>,
  req: Request | ServerRequest,
) {
  const res = mockRes();
  await handler(req as never, res);
  return res;
}

describe('requirePlatformToken', () => {
  const run = (token: string | undefined, header?: string) => {
    const res = mockRes();
    const next = jest.fn();
    const req = { get: () => header } as unknown as Request;
    requirePlatformToken(token)(req, res, next);
    return { status: next.mock.calls.length ? 'next' : res.statusCode };
  };

  it('hides the API without a token and refuses a wrong one', () => {
    expect(run(undefined, `Bearer ${TOKEN}`).status).toBe(404);
    expect(run('short', 'Bearer short').status).toBe(404);
    expect(run(TOKEN, 'Bearer wrong').status).toBe(401);
    expect(run(TOKEN).status).toBe(401);
    expect(run(TOKEN, `Bearer ${TOKEN}`).status).toBe('next');
  });
});

describe('operator API', () => {
  it('creates a provider, keeps its key write-only and audits the operator', async () => {
    const { deps, handlers } = setup();

    const created = await call(
      handlers.putProvider,
      operatorReq({ name: 'Mistral Platform' }, provider),
    );
    const listed = await call(handlers.listProviders, operatorReq({}));

    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(listed.body)).not.toContain(KEY);
    expect(listed.body?.providers).toEqual([
      expect.objectContaining({ name: 'Mistral Platform', apiKeyPreview: '...abcd', tenants: [] }),
    ]);
    expect((await methods.findPlatformProviders(['Mistral Platform']))[0].apiKey).toBe(
      `enc:${KEY}`,
    );
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.provider_updated',
        actor: { type: 'service', id: 'olga', name: 'olga' },
      }),
    );
    expect(deps.invalidate).toHaveBeenCalled();
  });

  it('keeps the stored key when an update leaves it out', async () => {
    const { handlers } = setup();
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));

    const { apiKey: _key, ...withoutKey } = provider;
    const updated = await call(
      handlers.putProvider,
      operatorReq({ name: 'Mistral Platform' }, { ...withoutKey, models: ['small'] }),
    );

    expect(updated.statusCode).toBe(200);
    const [stored] = await methods.findPlatformProviders(['Mistral Platform']);
    expect(stored.apiKey).toBe(`enc:${KEY}`);
    expect(stored.models).toEqual(['small']);
  });

  it('stores the request fields a provider rejects and shows them to the operator', async () => {
    const { handlers } = setup();

    const created = await call(
      handlers.putProvider,
      operatorReq(
        { name: 'Mistral Platform' },
        { ...provider, dropParams: ['user', 'stop', 'user'] },
      ),
    );
    const listed = await call(handlers.listProviders, operatorReq({}));

    expect(created.statusCode).toBe(201);
    expect(listed.body?.providers).toEqual([
      expect.objectContaining({ dropParams: ['user', 'stop'] }),
    ]);
  });

  it('stores queue limits, shows them to the operator and removes them when left out', async () => {
    const { handlers } = setup();
    const limits = {
      concurrency: 4,
      requestsPerMinute: 60,
      tokensPerMinute: 200_000,
      maxWaitSeconds: 90,
    };

    const created = await call(
      handlers.putProvider,
      operatorReq({ name: 'Mistral Platform' }, { ...provider, limits }),
    );
    const listed = await call(handlers.listProviders, operatorReq({}));
    expect(created.statusCode).toBe(201);
    expect(listed.body?.providers).toEqual([expect.objectContaining({ limits })]);

    const { apiKey: _key, ...update } = provider;
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, update));
    const [stored] = await methods.findPlatformProviders(['Mistral Platform']);
    expect(stored.limits).toBeUndefined();
  });

  it('refuses limits outside their bounds or with unknown fields', async () => {
    const { handlers } = setup();
    for (const limits of [
      { concurrency: 0 },
      { requestsPerMinute: 1.5 },
      { maxWaitSeconds: 901 },
      { burst: 3 },
    ]) {
      const res = await call(
        handlers.putProvider,
        operatorReq({ name: 'Mistral Platform' }, { ...provider, limits }),
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses a new provider without key, a YAML name, bad fields and bad names', async () => {
    const { handlers } = setup();
    const { apiKey: _key, ...withoutKey } = provider;

    const cases = [
      [{ name: 'New' }, withoutKey, 400],
      [{ name: 'Mistral EU' }, provider, 409],
      [{ name: 'Bad/Name' }, provider, 400],
      [{ name: 'X' }, { ...provider, baseURL: 'ftp://x' }, 400],
      [{ name: 'X' }, { ...provider, models: [] }, 400],
      [{ name: 'X' }, { ...provider, extra: true }, 400],
      [{ name: 'X' }, { ...provider, dropParams: ['User Id'] }, 400],
    ] as const;
    for (const [params, body, status] of cases) {
      expect((await call(handlers.putProvider, operatorReq(params, body))).statusCode).toBe(status);
    }
    expect(await methods.listPlatformProviders()).toEqual([]);
  });

  it('assigns providers with a subset of their models and refuses others', async () => {
    const { deps, handlers } = setup();
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));

    const refused = await call(
      handlers.putTenantCatalog,
      operatorReq(
        { tenantId: 'tenant-a' },
        { byok: false, providers: [{ name: 'Mistral Platform', models: ['huge'] }] },
      ),
    );
    const saved = await call(
      handlers.putTenantCatalog,
      operatorReq(
        { tenantId: 'tenant-a' },
        { byok: true, providers: [{ name: 'Mistral Platform', models: ['small'] }] },
      ),
    );
    const system = await call(
      handlers.putTenantCatalog,
      operatorReq({ tenantId: '__SYSTEM__' }, { byok: true, providers: [] }),
    );

    expect(refused.statusCode).toBe(400);
    expect(saved.body).toEqual({
      byok: true,
      providers: [{ name: 'Mistral Platform', models: ['small'] }],
    });
    expect(system.statusCode).toBe(400);
    expect(deps.invalidate).toHaveBeenLastCalledWith('tenant-a');
    const read = await call(handlers.getTenantCatalog, operatorReq({ tenantId: 'tenant-a' }));
    expect(read.body).toMatchObject({ byok: true, own: [] });
  });

  it('refuses to delete a provider a tenant still has', async () => {
    const { handlers } = setup();
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));
    await methods.setTenantAssignments('tenant-a', {
      byok: false,
      providers: [{ name: 'Mistral Platform', models: ['small'] }],
    });

    const inUse = await call(handlers.deleteProvider, operatorReq({ name: 'Mistral Platform' }));
    await methods.setTenantAssignments('tenant-a', { byok: false, providers: [] });
    const deleted = await call(handlers.deleteProvider, operatorReq({ name: 'Mistral Platform' }));
    const missing = await call(handlers.deleteProvider, operatorReq({ name: 'Mistral Platform' }));

    expect(inUse.statusCode).toBe(409);
    expect(inUse.body).toEqual({ error: 'provider_in_use', tenants: ['tenant-a'] });
    expect(deleted.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
  });
});

describe('providers offered to all tenants', () => {
  it('stores the flag, keeps it when an update leaves it out and audits it', async () => {
    const { deps, handlers } = setup();

    const created = await call(
      handlers.putProvider,
      operatorReq({ name: 'Everyone' }, { ...provider, allTenants: true }),
    );
    const { apiKey: _key, ...withoutKey } = provider;
    const kept = await call(handlers.putProvider, operatorReq({ name: 'Everyone' }, withoutKey));
    const plain = await call(handlers.putProvider, operatorReq({ name: 'Plain' }, provider));
    const invalid = await call(
      handlers.putProvider,
      operatorReq({ name: 'Plain' }, { ...provider, allTenants: 'yes' }),
    );

    expect(created.body?.provider).toMatchObject({ name: 'Everyone', allTenants: true });
    expect(kept.body?.provider).toMatchObject({ allTenants: true });
    expect(plain.body?.provider).toMatchObject({ allTenants: false });
    expect(invalid.statusCode).toBe(400);
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.provider_updated',
        metadata: expect.objectContaining({ allTenants: true }),
      }),
    );
    const listed = await call(handlers.listProviders, operatorReq({}));
    expect(listed.body?.providers).toEqual([
      expect.objectContaining({ name: 'Everyone', allTenants: true }),
      expect.objectContaining({ name: 'Plain', allTenants: false }),
    ]);
  });

  it('refuses to delete one until the operator switches the flag off', async () => {
    const { handlers } = setup();
    await call(
      handlers.putProvider,
      operatorReq({ name: 'Everyone' }, { ...provider, allTenants: true }),
    );

    const refused = await call(handlers.deleteProvider, operatorReq({ name: 'Everyone' }));
    const { apiKey: _key, ...withoutKey } = provider;
    await call(
      handlers.putProvider,
      operatorReq({ name: 'Everyone' }, { ...withoutKey, allTenants: false }),
    );
    const deleted = await call(handlers.deleteProvider, operatorReq({ name: 'Everyone' }));

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({ error: 'provider_for_all_tenants' });
    expect(deleted.statusCode).toBe(204);
  });

  it('refuses to delete a provider a platform agent runs on', async () => {
    const { deps } = setup();
    const handlers = createPlatformCatalogHandlers({
      ...deps,
      agentsUsingProvider: async (name: string) => (name === 'Plain' ? ['platform_support'] : []),
    });
    await call(handlers.putProvider, operatorReq({ name: 'Plain' }, provider));

    const refused = await call(handlers.deleteProvider, operatorReq({ name: 'Plain' }));

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: 'provider_used_by_agents',
      agents: ['platform_support'],
    });
  });

  it('shows tenant admins those providers with all models, without duplicates', async () => {
    const { handlers } = setup();
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));
    await call(
      handlers.putProvider,
      operatorReq({ name: 'Everyone' }, { ...provider, region: undefined, allTenants: true }),
    );
    await methods.setTenantAssignments('tenant-a', {
      byok: false,
      providers: [
        { name: 'Mistral Platform', models: ['small'] },
        { name: 'Everyone', models: ['small'] },
      ],
    });

    const assigned = await call(handlers.getOwnCatalog, adminReq({}));
    const withoutCatalog = await call(handlers.getOwnCatalog, adminReq({}, {}, 'tenant-b'));

    expect(assigned.body?.providers).toEqual([
      {
        name: 'Mistral Platform',
        label: 'Mistral',
        region: 'EU (Paris)',
        country: 'FR',
        models: ['small'],
        allTenants: false,
      },
      {
        name: 'Everyone',
        label: 'Mistral',
        country: 'FR',
        models: ['small', 'large'],
        allTenants: true,
      },
    ]);
    expect(withoutCatalog.body).toEqual({
      byok: false,
      providers: [
        {
          name: 'Everyone',
          label: 'Mistral',
          country: 'FR',
          models: ['small', 'large'],
          allTenants: true,
        },
      ],
      own: [],
    });
  });
});

describe('tenant admin API', () => {
  const own = {
    baseURL: 'https://llm.a.example/v1',
    apiKey: 'sk-tenant-key-0123456789',
    models: ['m'],
  };

  async function withProvider(byok: boolean) {
    const { deps, handlers } = setup();
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));
    await methods.setTenantAssignments('tenant-a', {
      byok,
      providers: [{ name: 'Mistral Platform', models: ['small'] }],
    });
    return { deps, handlers };
  }

  it("shows the tenant its catalog without the operator's key", async () => {
    const { handlers } = await withProvider(false);

    const res = await call(handlers.getOwnCatalog, adminReq({}));

    expect(res.body).toEqual({
      byok: false,
      providers: [
        {
          name: 'Mistral Platform',
          label: 'Mistral',
          region: 'EU (Paris)',
          country: 'FR',
          models: ['small'],
          allTenants: false,
        },
      ],
      own: [],
    });
    expect(JSON.stringify(res.body)).not.toContain('api.mistral.ai');
  });

  it('refuses own endpoints until the operator enables BYOK', async () => {
    const { handlers } = await withProvider(false);

    const res = await call(handlers.putOwnEndpoint, adminReq({ name: 'Own' }, own));

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'byok_not_enabled' });
  });

  it('adds, updates and deletes an own endpoint in the caller tenant only', async () => {
    const { deps, handlers } = await withProvider(true);

    const created = await call(handlers.putOwnEndpoint, adminReq({ name: 'Own' }, own));
    const { apiKey: _key, ...withoutKey } = own;
    const updated = await call(
      handlers.putOwnEndpoint,
      adminReq({ name: 'Own' }, { ...withoutKey, models: ['m', 'n'] }),
    );
    const listed = await call(handlers.getOwnCatalog, adminReq({}));

    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(listed.body?.own).toEqual([
      { name: 'Own', baseURL: own.baseURL, models: ['m', 'n'], apiKeyPreview: '...6789' },
    ]);
    const dropping = await call(
      handlers.putOwnEndpoint,
      adminReq({ name: 'Own' }, { ...withoutKey, dropParams: ['user'] }),
    );
    expect(dropping.body).toMatchObject({ dropParams: ['user'] });
    expect((await methods.getTenantCatalog('tenant-a'))?.own[0].dropParams).toEqual(['user']);
    expect((await methods.getTenantCatalog('tenant-b'))?.own ?? []).toEqual([]);
    expect(deps.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.own_endpoint_updated',
        actor: expect.objectContaining({ type: 'user', id: 'admin1' }),
        tenantId: 'tenant-a',
      }),
    );
    expect(
      (await call(handlers.deleteOwnEndpoint, adminReq({ name: 'Own' }, {}, 'tenant-b')))
        .statusCode,
    ).toBe(404);
    expect((await call(handlers.deleteOwnEndpoint, adminReq({ name: 'Own' }))).statusCode).toBe(
      204,
    );
  });

  it('refuses taken names, plain http, restricted addresses and a missing key', async () => {
    const { handlers } = await withProvider(true);
    const { apiKey: _key, ...withoutKey } = own;

    const cases = [
      [{ name: 'Mistral EU' }, own, 409],
      [{ name: 'mistral platform' }, own, 409],
      [{ name: 'Own' }, { ...own, baseURL: 'http://llm.a.example/v1' }, 400],
      [{ name: 'Own' }, { ...own, baseURL: 'https://169.254.169.254/v1' }, 400],
      [{ name: 'Own' }, withoutKey, 400],
    ] as const;
    for (const [params, body, status] of cases) {
      expect((await call(handlers.putOwnEndpoint, adminReq(params, body))).statusCode).toBe(status);
    }
    expect((await methods.getTenantCatalog('tenant-a'))?.own).toEqual([]);
  });
});
