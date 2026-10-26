const {
  createPlatformAgentLock,
  createPlatformAgentService,
  createPlatformAgentHandlers,
} = require('@librechat/api');
const { decryptV3 } = require('@librechat/data-schemas');
const db = require('~/models');

/** Fork: agents the platform operator provides to tenants (`packages/api/src/platform/agents.ts`). */
const service = createPlatformAgentService({
  store: db,
  findPlatformProviders: db.findPlatformProviders,
  decrypt: decryptV3,
});

const handlers = createPlatformAgentHandlers({
  service,
  store: db,
  findPlatformProviders: db.findPlatformProviders,
  listPlatformMcpTools: () => db.listPlatformMcpTools(),
  recordAuditEntry: db.recordAuditEntry,
  auditFailClosed: process.env.AUDIT_LOG_FAIL_CLOSED === 'true',
});

const lock = createPlatformAgentLock({
  findAgent: (filter) => db.getAgent(filter, { platformAgentId: 1 }),
});

module.exports = { service, handlers, lock };
