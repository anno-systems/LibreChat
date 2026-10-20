const {
  openCheckpointDeletion,
  deleteAllSharedLinksWithCleanup,
  createErasureResolver,
  createTenantPurgeHandler,
} = require('@librechat/api');
const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const { processDeleteRequest } = require('~/server/services/Files/process');
const { invalidateCachedTools } = require('~/server/services/Config/getCachedTools');
const { getMCPManager, getMCPServersRegistry } = require('~/config');
const { maybeUninstallOAuthMCP } = require('~/server/services/MCP/oauthCleanup');
const { getAppConfig, invalidateConfigCaches } = require('~/server/services/Config');
const db = require('~/models');

/**
 * Fork: the operator's tenant deletion (`packages/api/src/platform/purge.ts`). The erasure
 * resolver is wired as in `routes/admin/users.js`, so a tenant's users are erased exactly like
 * one user an admin deletes.
 */
const resolveErasure = createErasureResolver({
  withTenant: (tenantId, operation) =>
    tenantId ? tenantStorage.run({ tenantId }, operation) : runAsSystem(operation),
  db,
  getAppConfig,
  getMCPManager,
  processDeleteRequest,
  invalidateCachedTools,
  mcpOAuth: {
    getRegistry: getMCPServersRegistry,
    getUserPrincipals: db.getUserPrincipals,
    uninstallOAuthMCP: maybeUninstallOAuthMCP,
  },
  openCheckpointDeletion,
  deleteSharedLinks: (userId) => deleteAllSharedLinksWithCleanup(userId, { awaitCleanup: true }),
});

const deleteTenant = createTenantPurgeHandler({
  purge: db,
  resolveErasure,
  deleteUserById: db.deleteUserById,
  invalidate: invalidateConfigCaches,
  recordAuditEntry: db.recordAuditEntry,
});

module.exports = { deleteTenant };
