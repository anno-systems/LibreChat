const express = require('express');
const {
  requirePlatformToken,
  createTenantAdminHandler,
  createPlatformBannerHandlers,
  createPlatformPricingHandlers,
  createMcpPricingHandlers,
  listConfiguredMcpServers,
} = require('@librechat/api');
const handlers = require('~/server/services/Config/platformCatalog');
const { deleteTenant } = require('~/server/services/platformTenants');
const platformAgents = require('~/server/services/platformAgents');
const { operator: modelMigrations } = require('~/server/services/modelMigration');
const { getAppConfig } = require('~/server/services/Config');
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

const banners = createPlatformBannerHandlers(db);
const pricing = createPlatformPricingHandlers(db);
const mcpPricing = createMcpPricingHandlers({
  store: db,
  listServers: async () =>
    listConfiguredMcpServers((await getAppConfig({ baseOnly: true }))?.mcpConfig),
  resolvePricing: () => db.resolvePricing(),
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
router.get('/banners', banners.listBanners);
router.put('/banners/:id', banners.putBanner);
router.delete('/banners/:id', banners.deleteBanner);
router.get('/pricing', pricing.getPricing);
router.put('/pricing', pricing.putDefaultPricing);
router.put('/tenants/:tenantId/pricing', pricing.putTenantPricing);
router.delete('/tenants/:tenantId/pricing', pricing.deleteTenantPricing);
router.get('/mcp-pricing', mcpPricing.getMcpPricing);
router.put('/mcp-pricing/:server', mcpPricing.putMcpPrice);
router.delete('/mcp-pricing/:server', mcpPricing.deleteMcpPrice);
router.get('/agents', platformAgents.handlers.listAgents);
router.get('/agents/tools', platformAgents.handlers.listTools);
router.put('/agents/:id', platformAgents.handlers.putAgent);
router.delete('/agents/:id', platformAgents.handlers.deleteAgent);
router.get('/model-redirects', modelMigrations.listRedirects);
router.delete('/model-redirects/:id', modelMigrations.deleteRedirect);
router.post('/model-migrations/preview', modelMigrations.preview);
router.post('/model-migrations', modelMigrations.migrate);
router.post('/model-usage', modelMigrations.usage);

module.exports = router;
