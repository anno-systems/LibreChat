const { createPlatformCatalogHandlers } = require('@librechat/api');
const { encryptV3, decryptV3 } = require('@librechat/data-schemas');
const { getAppConfig, invalidateConfigCaches } = require('./app');
const { guard } = require('~/server/services/modelMigration');
const db = require('~/models');

/** Fork: handlers of the platform model catalog, shared by the operator and tenant admin routes. */
module.exports = createPlatformCatalogHandlers({
  catalog: db,
  encrypt: encryptV3,
  decrypt: decryptV3,
  getBaseConfig: () => getAppConfig({ baseOnly: true }),
  invalidate: invalidateConfigCaches,
  agentsUsingProvider: db.platformAgentsUsingProvider,
  modelGuard: guard,
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
});
