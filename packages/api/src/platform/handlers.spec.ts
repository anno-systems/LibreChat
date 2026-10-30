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
  models: [
    { id: 'small', label: 'Mistral Small' },
    { id: 'large', location: { type: 'eu' } },
  ],
  location: { type: 'country', code: 'fr' },
};

/** What tenant admins see of the provider's models: labels and effective locations. */
const smallView = {
  id: 'small',
  label: 'Mistral Small',
  location: { type: 'country', code: 'FR' },
};
const largeView = { id: 'large', location: { type: 'eu' } };

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
    expect(stored.models).toEqual([{ id: 'small' }]);
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

  it('stores limits per model and queue settings, and removes them when left out', async () => {
    const { handlers } = setup();
    const models = [
      { id: 'small', limits: { concurrency: 4, requestsPerMinute: 60 } },
      { id: 'large', limits: {} },
    ];
    const queue = { maxWaitSeconds: 90, pauseSeconds: 5 };

    const created = await call(
      handlers.putProvider,
      operatorReq({ name: 'Mistral Platform' }, { ...provider, models, queue }),
    );
    const listed = await call(handlers.listProviders, operatorReq({}));
    expect(created.statusCode).toBe(201);
    /** Empty limits are no limits: that model has no queue. */
    expect(listed.body?.providers).toEqual([
      expect.objectContaining({ models: [models[0], { id: 'large' }], queue }),
    ]);

    const { apiKey: _key, ...update } = provider;
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, update));
    const [stored] = await methods.findPlatformProviders(['Mistral Platform']);
    expect(stored.queue).toBeUndefined();
    expect(stored.models.some((model) => model.limits)).toBe(false);
  });

  it('refuses limits and queue settings outside their bounds or with unknown fields', async () => {
    const { handlers } = setup();
    const bodies = [
      ...[{ concurrency: 0 }, { requestsPerMinute: 1.5 }, { maxWaitSeconds: 60 }, { burst: 3 }].map(
        (limits) => ({ ...provider, models: [{ id: 'small', limits }] }),
      ),
      ...[{ maxWaitSeconds: 901 }, { concurrency: 3 }].map((queue) => ({ ...provider, queue })),
    ];
    for (const body of bodies) {
      const res = await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, body));
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
      [{ name: 'X' }, { ...provider, models: ['a', { id: 'a' }] }, 400],
      [{ name: 'X' }, { ...provider, models: [{ id: 'a', extra: 1 }] }, 400],
      [{ name: 'X' }, { ...provider, location: { type: 'country', code: 'FRA' } }, 400],
      [{ name: 'X' }, { ...provider, location: { type: 'moon' } }, 400],
      /** The fields before model objects are gone. */
      [{ name: 'X' }, { ...provider, country: 'FR' }, 400],
      [{ name: 'X' }, { ...provider, region: 'EU' }, 400],
      [{ name: 'X' }, { ...provider, limits: { concurrency: 1 } }, 400],
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
      operatorReq(
        { name: 'Everyone' },
        { ...provider, location: { type: 'global' }, allTenants: true },
      ),
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

    const everyone = {
      name: 'Everyone',
      label: 'Mistral',
      models: [{ ...smallView, location: { type: 'global' } }, largeView],
      allTenants: true,
    };
    expect(assigned.body?.providers).toEqual([
      { name: 'Mistral Platform', label: 'Mistral', models: [smallView], allTenants: false },
      everyone,
    ]);
    expect(withoutCatalog.body).toEqual({ byok: false, providers: [everyone], own: [] });
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
        { name: 'Mistral Platform', label: 'Mistral', models: [smallView], allTenants: false },
      ],
      own: [],
    });
    expect(JSON.stringify(res.body)).not.toContain('api.mistral.ai');
    /** Queue limits are the operator's. */
    expect(JSON.stringify(res.body)).not.toContain('limits');
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
      adminReq(
        { name: 'Own' },
        {
          ...withoutKey,
          location: { type: 'eu' },
          models: ['m', { id: 'n', label: 'Model N', location: { type: 'country', code: 'de' } }],
        },
      ),
    );
    const listed = await call(handlers.getOwnCatalog, adminReq({}));

    expect(created.statusCode).toBe(201);
    expect(created.body).toEqual({ name: 'Own', baseURL: own.baseURL, models: [{ id: 'm' }] });
    expect(updated.statusCode).toBe(200);
    const models = [
      { id: 'm', location: { type: 'eu' } },
      { id: 'n', label: 'Model N', location: { type: 'country', code: 'DE' } },
    ];
    expect(updated.body).toMatchObject({ location: { type: 'eu' }, models });
    expect(listed.body?.own).toEqual([
      {
        name: 'Own',
        baseURL: own.baseURL,
        location: { type: 'eu' },
        models,
        apiKeyPreview: '...6789',
      },
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
      [{ name: 'Own' }, { ...own, models: [{ id: 'm', limits: { concurrency: 1 } }] }, 400],
    ] as const;
    for (const [params, body, status] of cases) {
      expect((await call(handlers.putOwnEndpoint, adminReq(params, body))).statusCode).toBe(status);
    }
    expect((await methods.getTenantCatalog('tenant-a'))?.own).toEqual([]);
  });
});

describe('creating providers', () => {
  const { name: _name, ...body } = { name: '', ...provider };

  it('derives the name from the label, unique among providers and YAML endpoints', async () => {
    const { deps } = setup();
    const handlers = createPlatformCatalogHandlers({
      ...deps,
      getBaseConfig: async () =>
        ({
          config: { endpoints: { custom: [{ name: 'Mistral EU' }, { name: 'Mistral' }] } },
        }) as unknown as AppConfig,
    });
    const named = async (label: string) => {
      const res = await call(handlers.postProvider, operatorReq({}, { ...body, label }));
      expect(res.statusCode).toBe(201);
      return (res.body?.provider as { name: string }).name;
    };

    expect(await named('Mistral EU')).toBe('mistral-eu');
    expect(await named('Mistral')).toBe('mistral-2');
    expect(await named('Mistral')).toBe('mistral-3');
    expect(await named('mistral!')).toBe('mistral-4');
    expect(await named('Ärzte Größe')).toBe('arzte-grosse');
    expect(await named('★')).toBe('provider');
  });

  it('keeps an explicit name for API clients and refuses a taken one', async () => {
    const { handlers } = setup();
    const created = await call(
      handlers.postProvider,
      operatorReq({}, { ...body, name: 'Mistral Platform' }),
    );
    const again = await call(
      handlers.postProvider,
      operatorReq({}, { ...body, name: 'mistral platform' }),
    );
    const yaml = await call(
      handlers.postProvider,
      operatorReq({}, { ...body, name: 'Mistral EU' }),
    );
    const bad = await call(handlers.postProvider, operatorReq({}, { ...body, name: 'Bad/Name' }));
    const keyless = await call(
      handlers.postProvider,
      operatorReq({}, { ...body, apiKey: undefined }),
    );

    expect(created.statusCode).toBe(201);
    expect(created.body?.provider).toMatchObject({ name: 'Mistral Platform' });
    expect(again.body).toEqual({ error: 'name_taken' });
    expect(yaml.body).toEqual({ error: 'name_taken' });
    expect(bad.statusCode).toBe(400);
    expect(keyless.body).toEqual({ error: 'api_key_required' });
  });

  it('keeps the name when the label changes', async () => {
    const { handlers } = setup();
    const created = await call(handlers.postProvider, operatorReq({}, body));
    const name = (created.body?.provider as { name: string }).name;
    const { apiKey: _key, ...update } = body;

    const renamed = await call(
      handlers.putProvider,
      operatorReq({ name }, { ...update, label: 'Mistral (Paris)' }),
    );

    expect(renamed.statusCode).toBe(200);
    expect(renamed.body?.provider).toMatchObject({ name: 'mistral', label: 'Mistral (Paris)' });
    expect((await methods.listPlatformProviders()).map((p) => p.name)).toEqual(['mistral']);
  });

  it('takes the next suffix when a concurrent create took the name', async () => {
    const { deps } = setup();
    let raced = false;
    const handlers = createPlatformCatalogHandlers({
      ...deps,
      catalog: {
        ...methods,
        createPlatformProvider: async (input) => {
          if (!raced) {
            raced = true;
            await methods.createPlatformProvider({ ...input, label: 'Other' });
          }
          return methods.createPlatformProvider(input);
        },
      },
    });

    const res = await call(handlers.postProvider, operatorReq({}, body));

    expect(res.body?.provider).toMatchObject({ name: 'mistral-2', label: 'Mistral' });
  });
});

describe('successors with model objects', () => {
  it('finds dropped models by id and labels successors with the model labels', async () => {
    const { deps } = setup();
    const migrate = jest.fn(async () => true);
    const check = jest.fn(async () => ({ ok: true as const }));
    const handlers = createPlatformCatalogHandlers({ ...deps, modelGuard: { check, migrate } });
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));
    const { apiKey: _key, ...update } = provider;

    const res = await call(
      handlers.putProvider,
      operatorReq(
        { name: 'Mistral Platform' },
        {
          ...update,
          models: [{ id: 'small-2', label: 'Mistral Small 2' }, provider.models[1]],
          successors: [
            {
              from: { endpoint: 'Mistral Platform', model: 'small' },
              to: { endpoint: 'Mistral Platform', model: 'small-2' },
            },
          ],
        },
      ),
    );

    expect(res.statusCode).toBe(200);
    const successors = [
      {
        from: { endpoint: 'Mistral Platform', model: 'small', label: 'Mistral Small' },
        to: { endpoint: 'Mistral Platform', model: 'small-2', label: 'Mistral Small 2' },
      },
    ];
    expect(check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        removed: [{ endpoint: 'Mistral Platform', model: 'small' }],
        successors,
      }),
    );
    expect(migrate).toHaveBeenCalledWith(expect.anything(), { platform: true }, successors);
  });

  it('refuses the update when the guard finds a dropped model in use', async () => {
    const { deps } = setup();
    const handlers = createPlatformCatalogHandlers({
      ...deps,
      modelGuard: {
        check: async ({ removed }) =>
          removed.length > 0
            ? {
                ok: false,
                status: 409,
                body: {
                  error: 'model_in_use',
                  models: removed.map((ref) => ({ ...ref, agents: 1, conversations: 0 })),
                },
              }
            : { ok: true },
        migrate: async () => true,
      },
    });
    await call(handlers.putProvider, operatorReq({ name: 'Mistral Platform' }, provider));
    const { apiKey: _key, ...update } = provider;

    const relabelled = await call(
      handlers.putProvider,
      operatorReq(
        { name: 'Mistral Platform' },
        { ...update, models: [{ id: 'small', label: 'Renamed' }, 'large'] },
      ),
    );
    const dropped = await call(
      handlers.putProvider,
      operatorReq({ name: 'Mistral Platform' }, { ...update, models: ['large'] }),
    );

    /** A new label or location is no removal. */
    expect(relabelled.statusCode).toBe(200);
    expect(dropped.statusCode).toBe(409);
    expect(dropped.body).toEqual({
      error: 'model_in_use',
      models: [{ endpoint: 'Mistral Platform', model: 'small', agents: 1, conversations: 0 }],
    });
  });
});
