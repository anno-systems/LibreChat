const express = require('express');
const request = require('supertest');

const middlewareCalls = [];
const mockGetTenantUsage = jest.fn();
const mockGetAppConfig = jest.fn();
const mockGetModelsConfig = jest.fn();
const mockGetTenantCosts = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin', READ_USAGE: 'read:usage' },
}));

jest.mock('@librechat/api', () => ({
  createAdminUsageHandler:
    ({ getTenantUsage }) =>
    async (req, res) =>
      res.json(await getTenantUsage({ tenantId: req.user.tenantId, days: 30 })),
  createAdminCostsHandler: (deps) => async (req, res) => {
    const costs = await deps.getTenantCosts({ tenantId: req.user.tenantId });
    const people = await deps.hasCapability(req.user, 'read:users');
    const subscriptions = await deps.listMcpSubscriptions(req.user.tenantId);
    const servers = await deps.listMcpServers();
    res.json({
      ...costs,
      people,
      currency: deps.resolvePricing(req.user.tenantId).currency,
      subscriptions,
      servers,
    });
  },
  listConfiguredMcpServers: (mcpConfig) => Object.keys(mcpConfig ?? {}).map((name) => ({ name })),
  createAdminPricingHandler: (deps) => async (req, res) => {
    const config = await deps.getTenantAppConfig(req.user.tenantId);
    const models = await deps.getModelsConfig(req);
    res.json({ config, models, rate: deps.getMultiplier() });
  },
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: (...args) => mockGetModelsConfig(...args),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: async () => true,
  requireCapability: (capability) => (_req, _res, next) => {
    middlewareCalls.push(capability);
    next();
  },
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    middlewareCalls.push('jwt');
    req.user = { id: 'admin-1', tenantId: 'tenant-a' };
    next();
  },
}));

jest.mock('~/models', () => ({
  getTenantUsage: (...args) => mockGetTenantUsage(...args),
  getValueKey: jest.fn(),
  getMultiplier: () => 2.5,
  getCacheMultiplier: jest.fn(),
  getTenantCosts: (...args) => mockGetTenantCosts(...args),
  resolvePricing: () => ({ currency: { code: 'EUR', rate: 0.92 } }),
  listMcpSubscriptions: async (tenantId) => [{ tenantId, server: 'jira' }],
}));

describe('admin usage route', () => {
  beforeEach(() => {
    middlewareCalls.length = 0;
  });

  it('needs admin access and READ_USAGE, then answers with the tenant usage', async () => {
    mockGetTenantUsage.mockResolvedValue({ days: 30, totals: { messages: 3 } });
    const app = express();
    app.use('/api/admin/usage', require('./usage'));

    const res = await request(app).get('/api/admin/usage');

    expect(res.status).toBe(200);
    expect(res.body.totals.messages).toBe(3);
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'read:usage']);
    expect(mockGetTenantUsage).toHaveBeenCalledWith({ tenantId: 'tenant-a', days: 30 });
  });

  it('serves model rates with READ_USAGE from the tenant-wide config', async () => {
    mockGetAppConfig.mockResolvedValue({ tenant: 'a' });
    mockGetModelsConfig.mockResolvedValue({ openAI: ['gpt-4o'] });
    const app = express();
    app.use('/api/admin/usage', require('./usage'));

    const res = await request(app).get('/api/admin/usage/pricing');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      config: { tenant: 'a' },
      models: { openAI: ['gpt-4o'] },
      rate: 2.5,
    });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'read:usage']);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
  });

  it('serves the tenant costs with READ_USAGE and the display currency', async () => {
    mockGetTenantCosts.mockResolvedValue({ totals: { tokenCredits: 3950 } });
    mockGetAppConfig.mockResolvedValue({ mcpConfig: { jira: { title: 'Jira' } } });
    const app = express();
    app.use('/api/admin/usage', require('./usage'));

    const res = await request(app).get('/api/admin/usage/costs');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totals: { tokenCredits: 3950 },
      people: true,
      currency: { code: 'EUR', rate: 0.92 },
      subscriptions: [{ tenantId: 'tenant-a', server: 'jira' }],
      servers: [{ name: 'jira' }],
    });
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'read:usage']);
    expect(mockGetTenantCosts).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
  });
});
