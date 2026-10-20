const {
  createToolPolicyHandlers,
  createToolPolicyResolver,
  groupIdsFromPrincipals,
} = require('@librechat/api');
const db = require('~/models');

/** Fork: the per-tool policy of the platform's MCP servers (`packages/api/src/platform/toolPolicy.ts`). */
const resolver = createToolPolicyResolver({
  policy: db,
  getUserGroupIds: async (userId) => groupIdsFromPrincipals(await db.getUserPrincipals({ userId })),
});

const handlers = createToolPolicyHandlers({
  policy: db,
  resolver,
  findUserIdByOpenId: async (tenantId, openidId) => {
    const user = await db.findUser({ openidId, tenantId }, '_id');
    return user ? String(user._id) : null;
  },
  groupExists: async (groupId) => Boolean(await db.findGroupById(groupId, { _id: 1 })),
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
});

module.exports = { resolver, handlers };
