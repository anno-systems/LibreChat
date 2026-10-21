const express = require('express');
const request = require('supertest');

const middlewareCalls = [];
const mockGetTenantUsage = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin', READ_USAGE: 'read:usage' },
}));

jest.mock('@librechat/api', () => ({
  createAdminUsageHandler:
    ({ getTenantUsage }) =>
    async (req, res) =>
      res.json(await getTenantUsage({ tenantId: req.user.tenantId, days: 30 })),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
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

jest.mock('~/models', () => ({ getTenantUsage: (...args) => mockGetTenantUsage(...args) }));

describe('admin usage route', () => {
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
});
