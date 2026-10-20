const express = require('express');
const { requirePlatformToken } = require('@librechat/api');
const { handlers } = require('~/server/services/platformToolPolicy');

/**
 * Fork: the platform MCP API (`PLATFORM_MCP_TOKEN`), called by the platform's MCP servers to
 * register their tools and read a user's tool modes. The proxy keeps `/api/platform` off public
 * hosts.
 */
const router = express.Router();

router.use(requirePlatformToken(process.env.PLATFORM_MCP_TOKEN));
router.put('/servers/:server/tools', handlers.registerTools);
router.get('/servers/:server/policy', handlers.getUserModes);

module.exports = router;
