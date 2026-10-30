const { CacheKeys } = require('librechat-data-provider');
const {
  operatorActor,
  createOperatorAudit,
  createAdminAuditEmitter,
  createCatalogModelCheck,
  createModelRemovalGuard,
  createModelLabelLookup,
  createAssignedProviderCheck,
  invalidateCachedAuthUserDoc,
  createModelMigrationService,
  createAdminMigrationHandlers,
  createOperatorMigrationHandlers,
} = require('@librechat/api');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getAppConfig, invalidateConfigCaches } = require('./Config/app');
const getLogStores = require('~/cache/getLogStores');
const db = require('~/models');

/** Fork: model migrations and redirects (`packages/api/src/migration`). */
const auditFailClosed = process.env.AUDIT_LOG_FAIL_CLOSED === 'true';
const authUserDocCacheStore = getLogStores(CacheKeys.AUTH_USER_DOC);

const service = createModelMigrationService({
  store: db,
  invalidateConfig: invalidateConfigCaches,
  invalidateUser: (userId) => invalidateCachedAuthUserDoc(authUserDocCacheStore, { userId }),
  labelOf: createModelLabelLookup({
    getConfig: (tenantId) => getAppConfig(tenantId ? { tenantId } : { baseOnly: true }),
    findPlatformProviders: db.findPlatformProviders,
  }),
  isAssignedProvider: createAssignedProviderCheck({
    findPlatformProviders: db.findPlatformProviders,
  }),
});

const operatorAudit = createOperatorAudit({
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed,
  logPrefix: '[modelMigration]',
});
const operatorId = (req) => operatorActor(req).id;

const guard = createModelRemovalGuard({
  service,
  listPlatformAgents: db.listPlatformAgents,
  audit: operatorAudit,
  operatorId,
});

const operator = createOperatorMigrationHandlers({
  service,
  store: db,
  isCatalogModel: createCatalogModelCheck({
    getBaseConfig: () => getAppConfig({ baseOnly: true }),
    findPlatformProviders: db.findPlatformProviders,
  }),
  audit: operatorAudit,
  operatorId,
});

const admin = createAdminMigrationHandlers({
  service,
  store: db,
  getTenantAppConfig: (tenantId) => getAppConfig({ tenantId }),
  getModelsConfig,
  audit: createAdminAuditEmitter({
    recordAuditEntry: db.recordAuditEntry,
    failClosed: auditFailClosed,
    logPrefix: '[modelMigration]',
  }),
});

module.exports = {
  guard,
  admin,
  operator,
};
