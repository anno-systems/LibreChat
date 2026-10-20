import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { createAdminConfigHandlers } from './config';
import { getCatalogLockIssues } from './catalog';

const catalog = {
  endpoints: {
    custom: [
      {
        name: 'Mistral EU',
        apiKey: '${MISTRAL_API_KEY}',
        baseURL: 'https://api.mistral.ai/v1',
        models: { default: ['mistral-small-latest', 'mistral-large-latest'], fetch: false },
      },
      {
        name: 'Fetched',
        apiKey: '${OTHER_KEY}',
        baseURL: 'https://example.com/v1',
        models: { default: ['a'], fetch: true },
      },
    ],
  },
};

const codes = (fields: Record<string, unknown>) =>
  getCatalogLockIssues(fields, catalog).map(({ path, code }) => ({ path, code }));

describe('getCatalogLockIssues', () => {
  it('accepts narrowing a catalog endpoint to a subset of its models', () => {
    expect(
      codes({
        'endpoints.custom': [{ name: 'Mistral EU', models: { default: ['mistral-small-latest'] } }],
      }),
    ).toEqual([]);
    expect(
      codes({ endpoints: { custom: [{ name: 'Mistral EU', models: { default: [] } }] } }),
    ).toEqual([]);
  });

  it('accepts sections without endpoints or environment references', () => {
    expect(codes({ 'interface.customWelcome': 'Hello', balance: { enabled: true } })).toEqual([]);
  });

  it('refuses models the catalog does not offer', () => {
    expect(
      codes({
        'endpoints.custom': [
          { name: 'Mistral EU', models: { default: ['mistral-small-latest', 'gpt-x'] } },
        ],
      }),
    ).toEqual([{ path: 'endpoints.custom.0.models.default.1', code: 'catalog_unknown_model' }]);
  });

  it('refuses redirecting a catalog endpoint or changing its other fields', () => {
    expect(
      codes({
        'endpoints.custom': [
          { name: 'Mistral EU', baseURL: 'https://attacker.example', models: { fetch: true } },
        ],
      }),
    ).toEqual([
      { path: 'endpoints.custom.0.baseURL', code: 'catalog_field_locked' },
      { path: 'endpoints.custom.0.models.fetch', code: 'catalog_field_locked' },
    ]);
  });

  it('refuses endpoints outside the catalog and every other endpoint section', () => {
    expect(
      codes({
        endpoints: {
          custom: [
            { name: 'Mine', baseURL: 'https://attacker.example', models: { default: ['x'] } },
          ],
          openAI: { titleModel: 'x' },
        },
      }),
    ).toEqual([
      { path: 'endpoints.openAI', code: 'catalog_endpoint_locked' },
      { path: 'endpoints.custom.0.name', code: 'catalog_unknown_endpoint' },
    ]);
  });

  it('refuses narrowing an endpoint whose models are fetched at runtime', () => {
    expect(
      codes({ 'endpoints.custom': [{ name: 'Fetched', models: { default: ['a'] } }] }),
    ).toEqual([{ path: 'endpoints.custom.0.models.default', code: 'catalog_models_fetched' }]);
  });

  it('refuses environment references anywhere, including inside longer strings', () => {
    expect(
      codes({
        'webSearch.serperApiKey': '${JWT_SECRET}',
        mcpServers: { x: { headers: { Authorization: 'Bearer ${MISTRAL_API_KEY}' } } },
      }),
    ).toEqual([
      { path: 'webSearch.serperApiKey', code: 'catalog_env_reference' },
      { path: 'mcpServers.x.headers.Authorization', code: 'catalog_env_reference' },
    ]);
  });
});

function mockReq(overrides = {}) {
  return {
    user: { id: 'u1', role: 'ADMIN', tenantId: 'tenant-a', _id: { toString: () => 'u1' } },
    params: { principalType: 'role', principalId: '__base__' },
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

function mockRes() {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: Record<string, unknown>) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function createHandlers(catalogLock: boolean) {
  const deps = {
    listAllConfigs: jest.fn().mockResolvedValue([]),
    findConfigByPrincipal: jest.fn().mockResolvedValue(null),
    upsertConfig: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {}, configVersion: 1 }),
    patchConfigFields: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {}, configVersion: 2 }),
    tombstoneConfigField: jest.fn(),
    unsetConfigField: jest.fn(),
    deleteConfig: jest.fn(),
    toggleConfigActiveTracked: jest.fn(),
    hasConfigCapability: jest.fn().mockResolvedValue(true),
    hasCapability: jest.fn().mockResolvedValue(true),
    getAppConfig: jest.fn().mockResolvedValue({ config: catalog }),
    catalogLock,
  };
  return { handlers: createAdminConfigHandlers(deps), deps };
}

const redirect = [{ fieldPath: 'webSearch.serperApiKey', value: '${JWT_SECRET}' }];

describe('admin config handlers with the catalog lock', () => {
  it('refuses a PATCH that references an environment variable and stores nothing', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();

    await handlers.patchConfigField(mockReq({ body: { entries: redirect } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid config override',
      code: 'CONFIG_OVERRIDE_INVALID',
      issues: [{ path: 'webSearch.serperApiKey', code: 'catalog_env_reference' }],
    });
    expect(deps.patchConfigFields).not.toHaveBeenCalled();
  });

  it('stores a PATCH that narrows the catalog', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();
    const custom = [{ name: 'Mistral EU', models: { default: ['mistral-small-latest'] } }];

    await handlers.patchConfigField(
      mockReq({ body: { entries: [{ fieldPath: 'endpoints.custom', value: custom }] } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(deps.patchConfigFields).toHaveBeenCalledWith(
      'role',
      '__base__',
      expect.anything(),
      { 'endpoints.custom': custom },
      expect.any(Number),
    );
  });

  it('refuses a full replace that redirects a catalog endpoint', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();
    const overrides = {
      endpoints: { custom: [{ name: 'Mistral EU', baseURL: 'https://attacker.example' }] },
    };

    await handlers.upsertConfigOverrides(mockReq({ body: { overrides } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body?.issues).toEqual([
      { path: 'endpoints.custom.0.baseURL', code: 'catalog_field_locked' },
    ]);
    expect(deps.upsertConfig).not.toHaveBeenCalled();
  });

  it('keeps upstream behaviour when the lock is off', async () => {
    const { handlers, deps } = createHandlers(false);
    const res = mockRes();

    await handlers.patchConfigField(mockReq({ body: { entries: redirect } }), res);

    expect(res.statusCode).toBe(200);
    expect(deps.patchConfigFields).toHaveBeenCalled();
  });
});
