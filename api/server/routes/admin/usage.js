const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const {
  createAdminUsageHandler,
  createAdminCostsHandler,
  createAdminPricingHandler,
  listConfiguredMcpServers,
} = require('@librechat/api');
const { hasCapability, requireCapability } = require('~/server/middleware/roles/capabilities');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

/** Fork: the tenant's chat usage (aggregates only), costs and model rates for the admin app. */
const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get(
  '/',
  requireCapability(SystemCapabilities.READ_USAGE),
  createAdminUsageHandler({ getTenantUsage: db.getTenantUsage }),
);
router.get(
  '/costs',
  requireCapability(SystemCapabilities.READ_USAGE),
  createAdminCostsHandler({
    getTenantCosts: db.getTenantCosts,
    resolvePricing: db.resolvePricing,
    hasCapability,
    listMcpSubscriptions: db.listMcpSubscriptions,
    listMcpServers: async () =>
      listConfiguredMcpServers((await getAppConfig({ baseOnly: true }))?.mcpConfig),
  }),
);
router.get(
  '/pricing',
  requireCapability(SystemCapabilities.READ_USAGE),
  createAdminPricingHandler({
    getTenantAppConfig: (tenantId) => getAppConfig({ tenantId }),
    getModelsConfig,
    getValueKey: db.getValueKey,
    getMultiplier: db.getMultiplier,
    getCacheMultiplier: db.getCacheMultiplier,
    resolvePricing: db.resolvePricing,
  }),
);

module.exports = router;
