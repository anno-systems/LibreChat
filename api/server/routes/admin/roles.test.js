const express = require('express');
const request = require('supertest');
const { SystemRoles, roleDefaults } = require('librechat-data-provider');

const mockGetRoleByName = jest.fn();
const mockCreateRoleByName = jest.fn();
const mockUpdateAccessPermissions = jest.fn();
const mockRecordAuditEntry = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'admin-1', _id: 'admin-1', role: 'ADMIN', tenantId: 'tenant-a' };
    next();
  },
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (_req, _res, next) => next(),
}));

jest.mock('~/server/services/Config', () => ({
  invalidateConfigCaches: jest.fn(),
}));

jest.mock('~/models', () => ({
  getRoleByName: (...args) => mockGetRoleByName(...args),
  createRoleByName: (...args) => mockCreateRoleByName(...args),
  updateAccessPermissions: (...args) => mockUpdateAccessPermissions(...args),
  recordAuditEntry: (...args) => mockRecordAuditEntry(...args),
}));

const rolesRouter = require('./roles');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/roles', rolesRouter);
  return app;
}

const adminRole = { name: SystemRoles.ADMIN, ...roleDefaults[SystemRoles.ADMIN] };
const userRole = { name: SystemRoles.USER, ...roleDefaults[SystemRoles.USER] };

beforeEach(() => {
  jest.clearAllMocks();
  const roles = { [SystemRoles.ADMIN]: adminRole, [SystemRoles.USER]: userRole };
  mockGetRoleByName.mockImplementation(async (name) => roles[name] ?? null);
  mockUpdateAccessPermissions.mockResolvedValue(undefined);
  mockRecordAuditEntry.mockResolvedValue(undefined);
});

describe('admin API role routes: admin lockout guard', () => {
  it('refuses a PATCH that switches off a permission of ADMIN', async () => {
    const res = await request(createApp())
      .patch('/api/admin/roles/ADMIN/permissions')
      .send({ permissions: { AGENTS: { USE: false } } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_permissions_locked');
    expect(mockUpdateAccessPermissions).not.toHaveBeenCalled();
  });

  it('refuses a bulk PATCH across several types when one value removes a permission', async () => {
    const res = await request(createApp())
      .patch('/api/admin/roles/ADMIN/permissions')
      .send({
        permissions: {
          AGENTS: { USE: true, CREATE: true },
          PROMPTS: { USE: true },
          MCP_SERVERS: { USE: true, CREATE: 'false' },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_permissions_locked');
    expect(mockUpdateAccessPermissions).not.toHaveBeenCalled();
  });

  it('lets a PATCH that only grants ADMIN permissions through', async () => {
    const res = await request(createApp())
      .patch('/api/admin/roles/ADMIN/permissions')
      .send({ permissions: { AGENTS: { USE: true } } });

    expect(res.status).toBe(200);
    expect(mockUpdateAccessPermissions).toHaveBeenCalledWith(
      SystemRoles.ADMIN,
      { AGENTS: { USE: true } },
      adminRole,
    );
  });

  it('lets other roles lose permissions as before', async () => {
    const res = await request(createApp())
      .patch('/api/admin/roles/USER/permissions')
      .send({ permissions: { AGENTS: { USE: false } } });

    expect(res.status).toBe(200);
    expect(mockUpdateAccessPermissions).toHaveBeenCalled();
  });

  it('refuses creating the role ADMIN with a permission off', async () => {
    const res = await request(createApp())
      .post('/api/admin/roles')
      .send({ name: 'ADMIN', permissions: { PROMPTS: { USE: false } } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_permissions_locked');
    expect(mockCreateRoleByName).not.toHaveBeenCalled();
  });
});
