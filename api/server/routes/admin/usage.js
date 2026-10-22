const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { createAdminUsageHandler, createAdminPricingHandler } = require('@librechat/api');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

/** Fork: the tenant's chat usage (aggregates only) and model rates for the admin dashboard. */
const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get(
  '/',
  requireCapability(SystemCapabilities.READ_USAGE),
  createAdminUsageHandler({ getTenantUsage: db.getTenantUsage }),
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
  }),
);

module.exports = router;
