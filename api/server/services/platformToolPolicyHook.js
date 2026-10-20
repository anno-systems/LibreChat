const { createToolPolicyHookFactory } = require('@librechat/api');
const { resolver } = require('./platformToolPolicy');

/**
 * Fork: tool approval hook module applying the platform's per-tool MCP policy. Listed in
 * `endpoints.agents.toolApproval.hooks` (`module: ./api/server/services/platformToolPolicyHook.js`).
 */
module.exports = () => createToolPolicyHookFactory(resolver);
