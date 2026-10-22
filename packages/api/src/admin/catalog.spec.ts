import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { createAdminConfigHandlers } from './config';
import { getCatalogLockIssues, getCatalogLockTombstoneIssue } from './catalog';

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
  mcpServers: {
    gmail: { type: 'streamable-http', url: 'https://gmail.mcp.example/mcp' },
    drive: { type: 'streamable-http', url: 'https://drive.mcp.example/mcp' },
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
      { path: 'mcpServers.x', code: 'catalog_unknown_mcp_server' },
    ]);
  });

  it('accepts switching a catalog MCP server off or out of the chat menu', () => {
    expect(codes({ 'mcpServers.gmail.enabled': false })).toEqual([]);
    expect(codes({ 'mcpServers.gmail': { enabled: true, chatMenu: false } })).toEqual([]);
    expect(codes({ mcpServers: { gmail: { enabled: false }, drive: { chatMenu: true } } })).toEqual(
      [],
    );
    expect(codes({ mcpServers: {} })).toEqual([]);
  });

  it('refuses redirecting a catalog MCP server or changing its other fields', () => {
    expect(
      codes({
        mcpServers: {
          gmail: {
            url: 'https://attacker.example/mcp',
            headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
            enabled: 'no',
          },
        },
        'mcpConfig.drive.type': 'sse',
        'mcpServers.drive.chatMenu': true,
      }),
    ).toEqual([
      { path: 'mcpServers.gmail.url', code: 'catalog_field_locked' },
      { path: 'mcpServers.gmail.headers', code: 'catalog_field_locked' },
      { path: 'mcpServers.gmail.enabled', code: 'catalog_field_locked' },
      { path: 'mcpConfig.drive.type', code: 'catalog_field_locked' },
    ]);
  });

  it('refuses switching file outputs on for a catalog MCP server (fork)', () => {
    expect(codes({ 'mcpServers.gmail.fileOutputs': true })).toEqual([
      { path: 'mcpServers.gmail.fileOutputs', code: 'catalog_field_locked' },
    ]);
    expect(codes({ mcpServers: { gmail: { fileOutputs: { maxBytes: 1 } } } })).toEqual([
      { path: 'mcpServers.gmail.fileOutputs', code: 'catalog_field_locked' },
    ]);
    expect(getCatalogLockTombstoneIssue('mcpServers.gmail.fileOutputs')).toEqual(
      expect.objectContaining({ code: 'catalog_field_locked' }),
    );
  });

  it('refuses MCP servers outside the catalog and non-object MCP sections', () => {
    expect(
      codes({ 'mcpServers.mine': { type: 'streamable-http', url: 'https://x.example' } }),
    ).toEqual([{ path: 'mcpServers.mine', code: 'catalog_unknown_mcp_server' }]);
    expect(codes({ 'mcpServers.mine.enabled': true })).toEqual([
      { path: 'mcpServers.mine', code: 'catalog_unknown_mcp_server' },
    ]);
    expect(codes({ mcpServers: ['gmail'] })).toEqual([
      { path: 'mcpServers', code: 'catalog_field_locked' },
    ]);
    expect(codes({ 'mcpServers.gmail': false })).toEqual([
      { path: 'mcpServers.gmail', code: 'catalog_field_locked' },
    ]);
  });
});

describe('getCatalogLockTombstoneIssue', () => {
  it('allows tombstones of the MCP switches and of other sections', () => {
    expect(getCatalogLockTombstoneIssue('mcpServers.gmail.enabled')).toBeNull();
    expect(getCatalogLockTombstoneIssue('mcpConfig.gmail.chatMenu')).toBeNull();
    expect(getCatalogLockTombstoneIssue('interface.customWelcome')).toBeNull();
  });

  it('refuses any other tombstone under the MCP sections', () => {
    for (const path of ['mcpServers', 'mcpServers.gmail', 'mcpServers.gmail.url']) {
      expect(getCatalogLockTombstoneIssue(path)).toEqual(
        expect.objectContaining({ path, code: 'catalog_field_locked' }),
      );
    }
    expect(getCatalogLockTombstoneIssue('mcpServers.gmail.headers.Authorization')).toEqual(
      expect.objectContaining({ code: 'catalog_field_locked' }),
    );
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

  it('stores a PATCH that switches a catalog MCP server off', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();

    await handlers.patchConfigField(
      mockReq({
        params: { principalType: 'role', principalId: 'USER' },
        body: { entries: [{ fieldPath: 'mcpServers.gmail.enabled', value: false }] },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(deps.patchConfigFields).toHaveBeenCalledWith(
      'role',
      'USER',
      expect.anything(),
      { 'mcpServers.gmail.enabled': false },
      expect.any(Number),
    );
  });

  it('refuses a PATCH that redirects a catalog MCP server', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();

    await handlers.patchConfigField(
      mockReq({
        params: { principalType: 'role', principalId: 'USER' },
        body: {
          entries: [{ fieldPath: 'mcpServers.gmail.url', value: 'https://attacker.example/mcp' }],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body?.issues).toEqual([
      { path: 'mcpServers.gmail.url', code: 'catalog_field_locked' },
    ]);
    expect(deps.patchConfigFields).not.toHaveBeenCalled();
  });

  it('refuses a full replace that adds an MCP server', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();
    const overrides = {
      mcpServers: { mine: { type: 'streamable-http', url: 'https://attacker.example/mcp' } },
    };

    await handlers.upsertConfigOverrides(
      mockReq({ params: { principalType: 'role', principalId: 'USER' }, body: { overrides } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body?.issues).toEqual([
      { path: 'mcpServers.mine', code: 'catalog_unknown_mcp_server' },
    ]);
    expect(deps.upsertConfig).not.toHaveBeenCalled();
  });

  it('refuses a tombstone under an MCP server other than its switches', async () => {
    const { handlers, deps } = createHandlers(true);
    const res = mockRes();

    await handlers.tombstoneConfigField(
      mockReq({
        params: { principalType: 'role', principalId: 'USER' },
        body: { fieldPath: 'mcpServers.gmail.headers' },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body?.issues).toEqual([
      { path: 'mcpServers.gmail.headers', code: 'catalog_field_locked' },
    ]);
    expect(deps.tombstoneConfigField).not.toHaveBeenCalled();
  });

  it('stores a tombstone of an MCP switch', async () => {
    const { handlers, deps } = createHandlers(true);
    deps.tombstoneConfigField.mockResolvedValue({ _id: 'c1', overrides: {}, configVersion: 2 });
    const res = mockRes();

    await handlers.tombstoneConfigField(
      mockReq({
        params: { principalType: 'role', principalId: 'USER' },
        body: { fieldPath: 'mcpServers.gmail.enabled' },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(deps.tombstoneConfigField).toHaveBeenCalledWith(
      'role',
      'USER',
      expect.anything(),
      'mcpServers.gmail.enabled',
      expect.any(Number),
    );
  });

  it('keeps upstream behaviour for MCP writes when the lock is off', async () => {
    const { handlers, deps } = createHandlers(false);
    const res = mockRes();

    await handlers.patchConfigField(
      mockReq({
        params: { principalType: 'role', principalId: 'USER' },
        body: {
          entries: [{ fieldPath: 'mcpServers.gmail.url', value: 'https://other.example/mcp' }],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(deps.patchConfigFields).toHaveBeenCalled();
  });

  it('keeps upstream behaviour when the lock is off', async () => {
    const { handlers, deps } = createHandlers(false);
    const res = mockRes();

    await handlers.patchConfigField(mockReq({ body: { entries: redirect } }), res);

    expect(res.statusCode).toBe(200);
    expect(deps.patchConfigFields).toHaveBeenCalled();
  });
});
