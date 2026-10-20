const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const handlers = require('~/server/services/Config/platformCatalog');
const { requireJwtAuth } = require('~/server/middleware');

/** Fork: a tenant's model catalog and its endpoints with its own key (`packages/api/src/platform`). */
const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get('/', requireCapability(SystemCapabilities.READ_CONFIGS), handlers.getOwnCatalog);
router.put(
  '/own/:name',
  requireCapability(SystemCapabilities.MANAGE_CONFIGS),
  handlers.putOwnEndpoint,
);
router.delete(
  '/own/:name',
  requireCapability(SystemCapabilities.MANAGE_CONFIGS),
  handlers.deleteOwnEndpoint,
);

module.exports = router;
