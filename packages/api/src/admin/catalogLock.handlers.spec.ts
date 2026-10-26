import mongoose from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigDeps = Parameters<typeof import('./config').createAdminConfigHandlers>[0];
type Handlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;

interface MockRes {
  statusCode: number;
  body: undefined | { issues?: Array<{ path: string; code: string }>; [key: string]: unknown };
  status: jest.Mock;
  json: jest.Mock;
}

const LIFECYCLE_TIMEOUT_MS = 180_000;

/** librechat.yaml as the operator's catalog (fork: `ADMIN_CONFIG_CATALOG_LOCK`). */
const CATALOG = {
  endpoints: {
    custom: [
      {
        name: 'Mistral EU',
        apiKey: '${MISTRAL_API_KEY}',
        baseURL: 'https://api.mistral.ai/v1',
        models: { default: ['mistral-small-latest', 'mistral-large-latest'] },
      },
    ],
  },
  mcpServers: {
    gmail: { type: 'streamable-http', url: 'https://gmail.mcp.example/mcp' },
  },
};

const THEME = {
  version: 1,
  name: 'tenant-look',
  modes: {
    light: { colors: { 'rgb-surface-submit': '4 120 87' }, appearance: { radiusLg: '0.25rem' } },
    dark: { colors: { 'rgb-surface-submit': '52 211 153' } },
  },
};

/** Shaped as the config schema wants, so only the paint rules can refuse it. */
const BROKEN_THEME = {
  ...THEME,
  modes: {
    light: { colors: { 'rgb-surface-submit': '300 0 0' }, appearance: { radiusLg: 'big' } },
  },
};

let mongoServer: MongoMemoryServer;
let methods: Methods;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;

function mockReq(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    user: { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

function mockRes(): Response & MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: MockRes['body']) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function createHandlers(catalogLock: boolean): Handlers {
  const deps: AdminConfigDeps = {
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: async () => ({ config: CATALOG }) as unknown as AppConfig,
    invalidateConfigCaches: jest.fn(async () => undefined),
    catalogLock,
  };
  return createAdminConfigHandlers(deps);
}

let counter = 0;
function nextParams(): { principalType: PrincipalType; principalId: string } {
  counter += 1;
  return { principalType: PrincipalType.ROLE, principalId: `lock-${counter}` };
}

type HandlerName =
  | 'upsertConfigOverrides'
  | 'patchConfigField'
  | 'tombstoneConfigField'
  | 'applyConfigChanges';

async function call(
  name: HandlerName,
  body: Record<string, unknown>,
  { catalogLock = true, params = nextParams() } = {},
): Promise<{ res: MockRes; stored: Record<string, unknown> | null }> {
  const res = mockRes();
  await createHandlers(catalogLock)[name](mockReq({ params, body }), res);
  const stored = await methods.findConfigByPrincipal(params.principalType, params.principalId, {
    includeInactive: true,
  });
  return { res, stored: stored as unknown as Record<string, unknown> | null };
}

const issues = (res: MockRes) => res.body?.issues?.map(({ path, code }) => ({ path, code }));

beforeAll(async () => {
  const [dataSchemas, handlersModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    MongoMemoryServer.create(),
  ]);
  mongoServer = server;
  ({ createAdminConfigHandlers } = handlersModule);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);

  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = dataSchemas.createMethods(mongoose);
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

describe('admin config writes under the catalog lock (fork)', () => {
  it('refuses a PATCH that references an environment variable librechat.yaml allows', async () => {
    const { res, stored } = await call('patchConfigField', {
      entries: [{ fieldPath: 'webSearch.serperApiKey', value: '${MISTRAL_API_KEY}' }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body?.code).toBe('CONFIG_OVERRIDE_INVALID');
    expect(issues(res)).toEqual([
      { path: 'webSearch.serperApiKey', code: 'catalog_env_reference' },
    ]);
    expect(stored).toBeNull();
  });

  it('stores a PATCH that narrows a catalog endpoint and switches an MCP server off', async () => {
    const custom = [{ name: 'Mistral EU', models: { default: ['mistral-small-latest'] } }];
    const { res, stored } = await call('patchConfigField', {
      entries: [
        { fieldPath: 'endpoints.custom', value: custom },
        { fieldPath: 'mcpServers.gmail.enabled', value: false },
        { fieldPath: 'endpoints.agents.pullRequests.enabled', value: true },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(stored?.overrides).toEqual({
      endpoints: { custom, agents: { pullRequests: { enabled: true } } },
      mcpServers: { gmail: { enabled: false } },
    });
  });

  it('refuses a PATCH entry addressed by segments that redirects a catalog MCP server', async () => {
    const { res, stored } = await call('patchConfigField', {
      entries: [{ segments: ['mcpServers', 'gmail', 'url'], value: 'https://attacker.example' }],
    });

    expect(res.statusCode).toBe(400);
    expect(issues(res)).toEqual([{ path: 'mcpServers.gmail.url', code: 'catalog_field_locked' }]);
    expect(stored).toBeNull();
  });

  it('refuses a full replace that redirects a catalog endpoint or adds an MCP server', async () => {
    const { res, stored } = await call('upsertConfigOverrides', {
      overrides: {
        endpoints: { custom: [{ name: 'Mistral EU', baseURL: 'https://attacker.example' }] },
        mcpServers: { mine: { type: 'streamable-http', url: 'https://attacker.example/mcp' } },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(issues(res)).toEqual([
      { path: 'mcpServers.mine', code: 'catalog_unknown_mcp_server' },
      { path: 'endpoints.custom.0.baseURL', code: 'catalog_field_locked' },
    ]);
    expect(stored).toBeNull();
  });

  it('refuses a tombstone under an MCP server other than its switches, and stores one of them', async () => {
    const refused = await call('tombstoneConfigField', { fieldPath: 'mcpServers.gmail.headers' });
    expect(refused.res.statusCode).toBe(400);
    expect(issues(refused.res)).toEqual([
      { path: 'mcpServers.gmail.headers', code: 'catalog_field_locked' },
    ]);
    expect(refused.stored).toBeNull();

    const stored = await call('tombstoneConfigField', { fieldPath: 'mcpServers.gmail.enabled' });
    expect(stored.res.statusCode).toBe(200);
    expect(stored.stored?.tombstones).toEqual(['mcpServers.gmail.enabled']);
  });

  it('applies a changes batch that only narrows', async () => {
    const { res, stored } = await call('applyConfigChanges', {
      ops: [
        { op: 'set', fieldPath: 'mcpServers.gmail.chatMenu', value: false },
        {
          op: 'upsertEntry',
          fieldPath: 'endpoints.custom',
          entry: { name: 'Mistral EU', models: { default: ['mistral-large-latest'] } },
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(stored?.overrides).toEqual({
      mcpServers: { gmail: { chatMenu: false } },
      endpoints: {
        custom: [{ name: 'Mistral EU', models: { default: ['mistral-large-latest'] } }],
      },
    });
  });

  it.each([
    [
      'a set that redirects an MCP server',
      { op: 'set', fieldPath: 'mcpServers.gmail.url', value: 'https://attacker.example' },
      'mcpServers.gmail.url',
      'catalog_field_locked',
    ],
    [
      'an upserted endpoint outside the catalog',
      {
        op: 'upsertEntry',
        fieldPath: 'endpoints.custom',
        entry: { name: 'Mine', baseURL: 'https://attacker.example', models: { default: ['m'] } },
      },
      'endpoints.custom.0.name',
      'catalog_unknown_endpoint',
    ],
    [
      'a tombstone of a whole MCP server',
      { op: 'tombstone', fieldPath: 'mcpServers.gmail' },
      'mcpServers.gmail',
      'catalog_field_locked',
    ],
    [
      'an environment reference',
      { op: 'set', fieldPath: 'webSearch.serperApiKey', value: '${MISTRAL_API_KEY}' },
      'webSearch.serperApiKey',
      'catalog_env_reference',
    ],
  ])('refuses a changes batch with %s and stores nothing', async (_label, op, path, code) => {
    const { res, stored } = await call('applyConfigChanges', {
      ops: [{ op: 'set', fieldPath: 'mcpServers.gmail.enabled', value: false }, op],
    });

    expect(res.statusCode).toBe(400);
    expect(issues(res)).toEqual([{ path, code }]);
    expect(stored).toBeNull();
  });

  it("keeps upstream's behaviour when the lock is off", async () => {
    const { res, stored } = await call(
      'patchConfigField',
      { entries: [{ fieldPath: 'mcpServers.gmail.url', value: 'https://other.example/mcp' }] },
      { catalogLock: false },
    );

    expect(res.statusCode).toBe(200);
    expect(stored?.overrides).toEqual({
      mcpServers: { gmail: { url: 'https://other.example/mcp' } },
    });
  });
});

describe('admin config writes with a theme (fork)', () => {
  const brokenPaths = [
    { path: 'interface.theme.modes.light.colors.rgb-surface-submit', code: 'theme_invalid' },
    { path: 'interface.theme.modes.light.appearance.radiusLg', code: 'theme_invalid' },
  ];

  it('refuses a PATCH whose theme cannot be painted, naming where, and stores nothing', async () => {
    const { res, stored } = await call(
      'patchConfigField',
      { entries: [{ fieldPath: 'interface.theme', value: BROKEN_THEME }] },
      { catalogLock: false },
    );

    expect(res.statusCode).toBe(400);
    expect(issues(res)).toEqual(brokenPaths);
    expect(stored).toBeNull();
  });

  it('refuses a full replace and a changes set with such a theme', async () => {
    const replaced = await call(
      'upsertConfigOverrides',
      { overrides: { interface: { theme: BROKEN_THEME } } },
      { catalogLock: false },
    );
    expect(replaced.res.statusCode).toBe(400);
    expect(issues(replaced.res)).toEqual(brokenPaths);
    expect(replaced.stored).toBeNull();

    const changed = await call(
      'applyConfigChanges',
      { ops: [{ op: 'set', fieldPath: 'interface.theme', value: BROKEN_THEME }] },
      { catalogLock: false },
    );
    expect(changed.res.statusCode).toBe(400);
    expect(issues(changed.res)).toEqual(brokenPaths);
    expect(changed.stored).toBeNull();
  });

  it('stores a PATCH with a paintable theme', async () => {
    const { res, stored } = await call(
      'patchConfigField',
      { entries: [{ fieldPath: 'interface.theme', value: THEME }] },
      { catalogLock: false },
    );

    expect(res.statusCode).toBe(200);
    expect(stored?.overrides).toEqual({ interface: { theme: THEME } });
  });
});
