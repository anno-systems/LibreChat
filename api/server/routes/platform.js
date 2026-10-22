const express = require('express');
const { requirePlatformToken, createTenantAdminHandler } = require('@librechat/api');
const handlers = require('~/server/services/Config/platformCatalog');
const { deleteTenant } = require('~/server/services/platformTenants');
const db = require('~/models');

/**
 * Fork: the operator API (`PLATFORM_API_TOKEN`), called by the admin app's server only. The
 * proxy must keep `/api/platform` off public hosts.
 */
const router = express.Router();

const putTenantAdmin = createTenantAdminHandler({
  findUser: db.findUser,
  updateUser: db.updateUser,
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
});

router.use(requirePlatformToken(process.env.PLATFORM_API_TOKEN));
router.get('/providers', handlers.listProviders);
router.put('/providers/:name', handlers.putProvider);
router.delete('/providers/:name', handlers.deleteProvider);
router.get('/tenants/:tenantId/catalog', handlers.getTenantCatalog);
router.put('/tenants/:tenantId/catalog', handlers.putTenantCatalog);
router.put('/tenants/:tenantId/admins/:subject', putTenantAdmin);
router.delete('/tenants/:tenantId', deleteTenant);

module.exports = router;
