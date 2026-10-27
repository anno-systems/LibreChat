const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { createMcpSubscriptionHandlers } = require('@librechat/api');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

/** Fork: the tenant's subscriptions to the platform's priced MCP servers. */
const router = express.Router();

const handlers = createMcpSubscriptionHandlers({
  store: db,
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
});

router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.get('/', requireCapability(SystemCapabilities.READ_CONFIGS), handlers.listSubscriptions);
router.put(
  '/:server',
  requireCapability(SystemCapabilities.MANAGE_MCP_SERVERS),
  handlers.subscribe,
);
router.delete(
  '/:server',
  requireCapability(SystemCapabilities.MANAGE_MCP_SERVERS),
  handlers.unsubscribe,
);

module.exports = router;
