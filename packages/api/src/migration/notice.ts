import { logger } from '@librechat/data-schemas';
import type { ModelMigrationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The one-time notice of a model migration (fork-only): "Now runs on X instead of Y". A migrated
 * conversation keeps its notice until its owner has been shown it; a migrated agent until an
 * editor has seen it in the agent builder. The routes that read and clear them check access
 * first (the conversation's owner; EDIT on the agent).
 */

type Handler = (req: ServerRequest, res: Response) => Promise<Response>;

export interface ModelMigrationNoticeHandlers {
  /** GET /api/convos/:conversationId/model-migration → `{ modelMigration: notice | null }` */
  getConversationNotice: Handler;
  /** DELETE /api/convos/:conversationId/model-migration → 204 */
  clearConversationNotice: Handler;
  /** DELETE /api/agents/:id/model-migration → 204 (EDIT checked by the route) */
  clearAgentNotice: Handler;
}

function fail(res: Response, label: string, error: unknown): Response {
  logger.error(`[modelMigration] ${label} failed`, getSafeErrorMetadata(error));
  return res.status(500).json({ error: 'Internal server error' });
}

const param = (req: ServerRequest, name: string) =>
  String((req.params as Record<string, string | undefined>)[name] ?? '');

export function createModelMigrationNoticeHandlers(
  store: Pick<
    ModelMigrationMethods,
    'getConversationModelMigration' | 'clearConversationModelMigration' | 'clearAgentModelMigration'
  >,
): ModelMigrationNoticeHandlers {
  return {
    async getConversationNotice(req, res) {
      try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const notice = await store.getConversationModelMigration(
          userId,
          param(req, 'conversationId'),
        );
        return res.json({
          modelMigration: notice && {
            id: notice.id,
            from: notice.from,
            to: notice.to,
            at: new Date(notice.at).toISOString(),
          },
        });
      } catch (error) {
        return fail(res, 'conversation notice read', error);
      }
    },

    async clearConversationNotice(req, res) {
      try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        await store.clearConversationModelMigration(userId, param(req, 'conversationId'));
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'conversation notice clear', error);
      }
    },

    async clearAgentNotice(req, res) {
      try {
        await store.clearAgentModelMigration(param(req, 'id'));
        return res.status(204).end();
      } catch (error) {
        return fail(res, 'agent notice clear', error);
      }
    },
  };
}
