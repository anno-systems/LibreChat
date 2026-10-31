const express = require('express');
const { requirePlatformToken, createApprovalKeyHandler } = require('@librechat/api');
const { handlers } = require('~/server/services/platformToolPolicy');
const { signer } = require('~/server/services/mcpApproval');

/**
 * Fork: the platform MCP API (`PLATFORM_MCP_TOKEN`), called by the platform's MCP servers to
 * register their tools, read a user's tool modes and the public key of signed tool approvals
 * (`approval-key`). The proxy keeps `/api/platform` off public
 * hosts.
 */
const router = express.Router();

router.use(requirePlatformToken(process.env.PLATFORM_MCP_TOKEN));
router.put('/servers/:server/tools', handlers.registerTools);
router.get('/servers/:server/policy', handlers.getUserModes);
router.get('/approval-key', createApprovalKeyHandler(signer));

module.exports = router;
