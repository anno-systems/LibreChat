import mongoose from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

/**
 * The writes the fork's admin app (anno-systems/admin-app, `server/src/librechat.ts`) makes through
 * the admin config API, under the catalog lock as the platform runs it. Each one must keep
 * working across upstream merges: field PATCHes and removals on the base document, whole group
 * documents, and the reads that follow them.
 */

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type Handlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

const LIFECYCLE_TIMEOUT_MS = 180_000;
const BASE = { principalType: PrincipalType.ROLE, principalId: '__base__' };
/** The base document's priority as the admin app writes it. */
const BASE_PRIORITY = 10;

const YAML = {
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
    gmail: { type: 'streamable-http', url: 'https://gmail.mcp.example/mcp', enabled: false },
  },
};

const THEME = {
  version: 1,
  name: 'tenant-look',
  modes: {
    light: { colors: { 'rgb-surface-submit': '4 120 87' } },
    dark: { colors: { 'rgb-surface-submit': '52 211 153' } },
  },
};

/** MIME types are record keys, several of them with dots. */
const DELIVERY = {
  'application/pdf': 'provider',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'text',
  'image/*': 'provider',
};

let mongoServer: MongoMemoryServer;
let methods: Methods;
let handlers: Handlers;

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

async function call(
  name: keyof Handlers,
  req: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> },
): Promise<MockRes> {
  const res = mockRes();
  const request = {
    user: { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } },
    params: {},
    body: {},
    query: {},
    ...req,
  } as Partial<ServerRequest> as ServerRequest;
  await handlers[name](request, res);
  return res;
}

const patchBase = (entries: Array<{ fieldPath: string; value: unknown }>) =>
  call('patchConfigField', { params: BASE, body: { entries, priority: BASE_PRIORITY } });

const deleteBaseField = (fieldPath: string) =>
  call('deleteConfigField', { params: BASE, query: { fieldPath } });

async function baseOverrides(): Promise<Record<string, unknown>> {
  const res = await call('getConfig', { params: BASE });
  expect(res.statusCode).toBe(200);
  return (res.body?.config as { overrides: Record<string, unknown> }).overrides;
}

beforeAll(async () => {
  const [dataSchemas, handlersModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    MongoMemoryServer.create(),
  ]);
  mongoServer = server;
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);

  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = dataSchemas.createMethods(mongoose);
  handlers = handlersModule.createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: async () => ({ config: YAML }) as unknown as AppConfig,
    invalidateConfigCaches: jest.fn(async () => undefined),
    catalogLock: true,
  });
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

describe('the admin app writes through the admin config API (fork)', () => {
  it('writes file handling as one field whose record keys contain dots, and removes it', async () => {
    const written = await patchBase([
      { fieldPath: 'fileConfig.defaultLLMDeliveryPath.overrides', value: DELIVERY },
    ]);
    expect(written.statusCode).toBe(200);
    expect(await baseOverrides()).toMatchObject({
      fileConfig: { defaultLLMDeliveryPath: { overrides: DELIVERY } },
    });

    const removed = await deleteBaseField('fileConfig.defaultLLMDeliveryPath.overrides');
    expect(removed.statusCode).toBe(200);
    expect(await baseOverrides()).not.toHaveProperty('fileConfig');
  });

  it('writes branding, theme, terms, welcome, balance, model narrowing and switches', async () => {
    const written = await patchBase([
      { fieldPath: 'interface.branding.appTitle', value: 'Acme AI' },
      { fieldPath: 'interface.branding.footer', value: 'Acme | [Help](https://acme.example)' },
      { fieldPath: 'interface.branding.logo', value: 'https://acme.example/logo.svg' },
      { fieldPath: 'interface.theme', value: THEME },
      {
        fieldPath: 'interface.termsOfService',
        value: { modalAcceptance: true, modalContent: 'Be nice.' },
      },
      { fieldPath: 'interface.customWelcome', value: 'Hello' },
      { fieldPath: 'balance', value: { enabled: true, startBalance: 1000 } },
      {
        fieldPath: 'endpoints.custom',
        value: [{ name: 'Mistral EU', models: { default: ['mistral-small-latest'] } }],
      },
      { fieldPath: 'mcpServers.gmail.enabled', value: true },
      { fieldPath: 'endpoints.agents.pullRequests.enabled', value: true },
    ]);
    expect(written.statusCode).toBe(200);
    expect(await baseOverrides()).toMatchObject({
      interface: {
        branding: { appTitle: 'Acme AI', logo: 'https://acme.example/logo.svg' },
        theme: THEME,
        customWelcome: 'Hello',
      },
      balance: { enabled: true, startBalance: 1000 },
      endpoints: {
        custom: [{ name: 'Mistral EU', models: { default: ['mistral-small-latest'] } }],
        agents: { pullRequests: { enabled: true } },
      },
      mcpServers: { gmail: { enabled: true } },
    });

    for (const fieldPath of [
      'interface.theme',
      'interface.branding.appTitle',
      'mcpServers.gmail.enabled',
      'endpoints.agents.pullRequests.enabled',
    ]) {
      expect((await deleteBaseField(fieldPath)).statusCode).toBe(200);
    }
    const after = await baseOverrides();
    expect(after).not.toHaveProperty('mcpServers');
    expect(after).toMatchObject({ interface: { branding: { footer: expect.any(String) } } });
    expect((after.interface as Record<string, unknown>).theme).toBeUndefined();
  });

  it('replaces, lists and deletes a group document', async () => {
    const group = { principalType: PrincipalType.GROUP, principalId: 'group-1' };
    const overrides = {
      endpoints: {
        custom: [{ name: 'Mistral EU', models: { default: ['mistral-large-latest'] } }],
      },
      interface: { customWelcome: 'Hi team' },
      balance: { startBalance: 500 },
    };

    const put = await call('upsertConfigOverrides', {
      params: group,
      body: { overrides, priority: 20 },
    });
    expect(put.statusCode).toBeLessThan(300);

    const listed = await call('listConfigs', {});
    const configs = listed.body?.configs as Array<Record<string, unknown>>;
    expect(configs.find((c) => c.principalId === 'group-1')).toMatchObject({
      principalType: 'group',
      priority: 20,
      overrides,
    });

    const replaced = await call('upsertConfigOverrides', {
      params: group,
      body: { overrides: { interface: { customWelcome: 'Hi again' } }, priority: 20 },
    });
    expect(replaced.statusCode).toBe(200);
    const stored = await methods.findConfigByPrincipal(PrincipalType.GROUP, 'group-1');
    expect(stored?.overrides).toEqual({ interface: { customWelcome: 'Hi again' } });

    expect((await call('deleteConfigOverrides', { params: group })).statusCode).toBe(200);
    expect((await call('deleteConfigOverrides', { params: group })).statusCode).toBe(404);
  });

  it('reads the deployment config as the tenant sees it', async () => {
    const res = await call('getBaseConfig', { query: { baseOnly: 'true' } });
    expect(res.statusCode).toBe(200);
    const config = (res.body?.config as { config: typeof YAML }).config;
    expect(config.endpoints.custom[0]).toMatchObject({ name: 'Mistral EU' });
    expect(config.mcpServers.gmail).toMatchObject({ enabled: false });
  });
});
