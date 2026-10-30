const express = require('express');
const { createModelMigrationNoticeHandlers } = require('@librechat/api');
const { PermissionBits } = require('librechat-data-provider');
const { requireJwtAuth, canAccessAgentResource } = require('~/server/middleware');
const db = require('~/models');

/**
 * Fork: the one-time notice of a model migration (`packages/api/src/migration/notice.ts`), for a
 * conversation's owner and an agent's editors. Mounted on `/api` ahead of the conversation and
 * agent routers.
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
router.delete(
  '/agents/:id/model-migration',
  requireJwtAuth,
  canAccessAgentResource({ requiredPermission: PermissionBits.EDIT, resourceIdParam: 'id' }),
  notices.clearAgentNotice,
);

module.exports = router;
