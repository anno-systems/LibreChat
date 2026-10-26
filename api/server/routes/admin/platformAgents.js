const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { handlers } = require('~/server/services/platformAgents');
const { requireJwtAuth } = require('~/server/middleware');

/** Fork: the platform agents meant for a tenant, which its admins switch on or off. */
const router = express.Router();

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get('/', requireCapability(SystemCapabilities.READ_AGENTS), handlers.listTenantAgents);
router.put('/:id', requireCapability(SystemCapabilities.MANAGE_AGENTS), handlers.putTenantAgent);

module.exports = router;
