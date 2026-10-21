const express = require('express');
const { createAdminUsageHandler } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

/** Fork: the tenant's chat usage (aggregates only) for the admin dashboard. */
const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get(
  '/',
  requireCapability(SystemCapabilities.READ_USAGE),
  createAdminUsageHandler({ getTenantUsage: db.getTenantUsage }),
);

module.exports = router;
