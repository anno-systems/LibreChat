const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { handlers } = require('~/server/services/platformToolPolicy');
const { requireJwtAuth } = require('~/server/middleware');

/** Fork: a tenant's per-tool policy of the platform's MCP servers. */
const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get('/', requireCapability(SystemCapabilities.READ_CONFIGS), handlers.getPolicy);
router.put('/policy', requireCapability(SystemCapabilities.MANAGE_MCP_SERVERS), handlers.putRule);

module.exports = router;
