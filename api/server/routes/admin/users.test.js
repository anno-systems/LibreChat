const express = require('express');
const request = require('supertest');

const middlewareCalls = [];
const mockGetUserById = jest.fn();
const mockRecordAuditEntry = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    middlewareCalls.push('jwt');
    req.user = { id: 'f'.repeat(24), _id: 'f'.repeat(24), role: 'ADMIN', tenantId: 'tenant-a' };
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: (capability) => (_req, _res, next) => {
    middlewareCalls.push(capability);
    next();
  },
}));

jest.mock('~/server/services/Agents/triggers', () => ({}));
jest.mock('~/server/services/Files/process', () => ({ processDeleteRequest: jest.fn() }));
jest.mock('~/server/services/Config/getCachedTools', () => ({ invalidateCachedTools: jest.fn() }));
jest.mock('~/config', () => ({ getMCPManager: jest.fn(), getMCPServersRegistry: jest.fn() }));
jest.mock('~/server/services/MCP/oauthCleanup', () => ({ maybeUninstallOAuthMCP: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));
jest.mock('~/server/services/Schedules', () => ({}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
  invalidateConfigCaches: jest.fn(),
  invalidateCodeEnvironmentConfigCache: jest.fn(),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  recordAuditEntry: (...args) => mockRecordAuditEntry(...args),
}));

const usersRouter = require('./users');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', usersRouter);
  return app;
}

const USER_ID = 'a'.repeat(24);

beforeEach(() => {
  jest.clearAllMocks();
  middlewareCalls.length = 0;
  mockGetUserById.mockImplementation(async (id) => (id === USER_ID ? { _id: id } : null));
  mockRecordAuditEntry.mockResolvedValue(undefined);
});

describe('POST /api/admin/users/:id/password-reset-events', () => {
  it('needs MANAGE_USERS, records the reset and answers 204 without a body', async () => {
    const res = await request(createApp()).post(
      `/api/admin/users/${USER_ID}/password-reset-events`,
    );

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'manage:users']);
    expect(mockRecordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password_reset_sent',
        actor: expect.objectContaining({ type: 'user', id: 'f'.repeat(24) }),
        target: { type: 'user', id: USER_ID },
        tenantId: 'tenant-a',
      }),
      { failClosed: true },
    );
  });

  it('answers 404 user_not_found for a user outside the tenant', async () => {
    const res = await request(createApp()).post(
      `/api/admin/users/${'b'.repeat(24)}/password-reset-events`,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('user_not_found');
    expect(mockRecordAuditEntry).not.toHaveBeenCalled();
  });
});
