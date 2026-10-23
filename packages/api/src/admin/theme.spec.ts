import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { createAdminConfigHandlers } from './config';
import { getThemeWriteIssues } from './theme';

const theme = {
  version: 1,
  name: 'tenant-look',
  modes: {
    light: { colors: { 'rgb-surface-submit': '4 120 87' }, appearance: { radiusLg: '0.25rem' } },
    dark: { colors: { 'rgb-surface-submit': '52 211 153' } },
  },
};

const paths = (fields: Record<string, unknown>) =>
  getThemeWriteIssues(fields).map(({ path, code }) => ({ path, code }));

describe('getThemeWriteIssues', () => {
  it('accepts a paintable theme, a bundled theme name and writes without a theme', () => {
    expect(paths({ 'interface.theme': theme })).toEqual([]);
    expect(paths({ interface: { theme: 'clickhouse' } })).toEqual([]);
    expect(paths({ 'interface.customWelcome': 'Hi' })).toEqual([]);
    expect(paths({ 'interface.theme': null })).toEqual([]);
  });

  it('names each part of a theme the client would refuse', () => {
    const broken = {
      ...theme,
      version: 2,
      modes: {
        light: {
          colors: { 'rgb-surface-submit': 'green' },
          appearance: { radiusLg: 'very round' },
        },
      },
    };
    expect(paths({ 'interface.theme': broken })).toEqual(
      expect.arrayContaining([
        { path: 'interface.theme.version', code: 'theme_invalid' },
        { path: 'interface.theme.modes.light.colors.rgb-surface-submit', code: 'theme_invalid' },
        { path: 'interface.theme.modes.light.appearance.radiusLg', code: 'theme_invalid' },
      ]),
    );
    expect(paths({ interface: { theme: 'no-such-theme' } })).toEqual([
      { path: 'interface.theme', code: 'theme_invalid' },
    ]);
  });
});

function createHandlers() {
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
    getAppConfig: jest.fn().mockResolvedValue({ config: {} }),
  };
  return { handlers: createAdminConfigHandlers(deps), deps };
}

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
  return res as MockRes & Response;
}

/** Shaped as the config schema wants, so only the paint rules can refuse it. */
const broken = {
  ...theme,
  modes: {
    light: { colors: { 'rgb-surface-submit': '300 0 0' }, appearance: { radiusLg: 'big' } },
  },
};

describe('admin config handlers with a theme (fork)', () => {
  it('refuses a PATCH whose theme cannot be painted, naming where, and stores nothing', async () => {
    const { handlers, deps } = createHandlers();
    const res = mockRes();

    await handlers.patchConfigField(
      mockReq({ body: { entries: [{ fieldPath: 'interface.theme', value: broken }] } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body?.issues).toEqual([
      { path: 'interface.theme.modes.light.colors.rgb-surface-submit', code: 'theme_invalid' },
      { path: 'interface.theme.modes.light.appearance.radiusLg', code: 'theme_invalid' },
    ]);
    expect(deps.patchConfigFields).not.toHaveBeenCalled();
  });

  it('refuses a full replace with such a theme', async () => {
    const { handlers, deps } = createHandlers();
    const res = mockRes();

    await handlers.upsertConfigOverrides(
      mockReq({ body: { overrides: { interface: { theme: broken } } } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(deps.upsertConfig).not.toHaveBeenCalled();
  });

  it('stores a PATCH with a paintable theme', async () => {
    const { handlers, deps } = createHandlers();
    const res = mockRes();

    await handlers.patchConfigField(
      mockReq({ body: { entries: [{ fieldPath: 'interface.theme', value: theme }] } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(deps.patchConfigFields).toHaveBeenCalled();
  });
});
