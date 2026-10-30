const express = require('express');
const { createModelMigrationNoticeHandlers } = require('@librechat/api');
const { PermissionBits } = require('librechat-data-provider');
const { requireJwtAuth, canAccessAgentResource } = require('~/server/middleware');
const db = require('~/models');

/**
 * Fork: the one-time notice of a model migration (`packages/api/src/migration/notice.ts`), for a
 * conversation's owner and, per user, everyone who can view a migrated agent. Mounted on `/api`
 * ahead of the conversation and agent routers.
 */
const router = express.Router();
const notices = createModelMigrationNoticeHandlers(db);

router.get(
  '/convos/:conversationId/model-migration',
  requireJwtAuth,
  notices.getConversationNotice,
);
router.delete(
  '/convos/:conversationId/model-migration',
  requireJwtAuth,
  notices.clearConversationNotice,
);
const canViewAgent = canAccessAgentResource({
  requiredPermission: PermissionBits.VIEW,
  resourceIdParam: 'id',
});
router.get('/agents/:id/model-migration', requireJwtAuth, canViewAgent, notices.getAgentNotice);
router.delete(
  '/agents/:id/model-migration',
  requireJwtAuth,
  canViewAgent,
  notices.clearAgentNotice,
);

module.exports = router;
