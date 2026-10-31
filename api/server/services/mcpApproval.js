const { loadMCPApprovalSigner } = require('@librechat/api');

/**
 * Fork: the signer for tool approvals sent to platform MCP servers (`MCP_APPROVAL_PRIVATE_KEY`);
 * undefined when the key is not set.
 */
module.exports = { signer: loadMCPApprovalSigner(process.env) };
