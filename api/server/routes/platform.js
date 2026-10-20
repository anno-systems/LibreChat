const express = require('express');
const { requirePlatformToken } = require('@librechat/api');
const handlers = require('~/server/services/Config/platformCatalog');

/**
 * Fork: the operator API (`PLATFORM_API_TOKEN`), called by the admin app's server only. The
 * proxy must keep `/api/platform` off public hosts.
 */
const router = express.Router();

router.use(requirePlatformToken(process.env.PLATFORM_API_TOKEN));
router.get('/providers', handlers.listProviders);
router.put('/providers/:name', handlers.putProvider);
router.delete('/providers/:name', handlers.deleteProvider);
router.get('/tenants/:tenantId/catalog', handlers.getTenantCatalog);
router.put('/tenants/:tenantId/catalog', handlers.putTenantCatalog);

module.exports = router;
