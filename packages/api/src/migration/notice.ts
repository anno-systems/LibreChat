import { logger } from '@librechat/data-schemas';
import type {
  ModelRef,
  ModelMigrationNotice,
  ModelMigrationMethods,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The one-time notice of a model migration (fork-only): "Now runs on X instead of Y", with each
 * model's display label when the migration knew one. Acknowledgements are per user:
 *
 * - A migrated conversation keeps its notice until its owner has been shown it.
 * - A migrated agent shows its notice to every user who opens a chat with it or its builder,
 *   once each, for 30 days after the migration (`AGENT_NOTICE_WINDOW_MS`). Seeing a
 *   conversation's notice counts as seeing the same migration's agent notice.
 *
 * The routes check access first (the conversation's owner; VIEW on the agent).
 */

type Handler = (req: ServerRequest, res: Response) => Promise<Response>;

/** The notice as the API answers it. */
export interface ModelMigrationNoticeView {
  id: string;
  from: ModelRef;
  to: ModelRef;
  at: string;
}

export interface ModelMigrationNoticeHandlers {
  /** GET /api/convos/:conversationId/model-migration → `{ modelMigration: notice | null }` */
  getConversationNotice: Handler;
  /** DELETE /api/convos/:conversationId/model-migration → 204 */
  clearConversationNotice: Handler;
  /** GET /api/agents/:id/model-migration → `{ modelMigration: notice | null }` for the caller */
  getAgentNotice: Handler;
  /** DELETE /api/agents/:id/model-migration → 204: the caller has seen it */
  clearAgentNotice: Handler;
}

function fail(res: Response, label: string, error: unknown): Response {
  logger.error(`[modelMigration] ${label} failed`, getSafeErrorMetadata(error));
  return res.status(500).json({ error: 'Internal server error' });
}

const param = (req: ServerRequest, name: string) =>
  String((req.params as Record<string, string | undefined>)[name] ?? '');

const ref = (model: ModelRef): ModelRef => ({
  endpoint: model.endpoint,
  model: model.model,
  ...(model.label && { label: model.label }),
});

export function noticeView(notice: ModelMigrationNotice | null): ModelMigrationNoticeView | null {
  if (!notice) return null;
  return {
    id: notice.id,
    from: ref(notice.from),
    to: ref(notice.to),
    at: new Date(notice.at).toISOString(),
  };
}

type UserHandler = (userId: string, req: ServerRequest, res: Response) => Promise<Response>;

function withUser(label: string, handle: UserHandler): Handler {
  return async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      return await handle(userId, req, res);
    } catch (error) {
      return fail(res, label, error);
    }
  };
}

export function createModelMigrationNoticeHandlers(
  store: Pick<
    ModelMigrationMethods,
    | 'getConversationModelMigration'
    | 'clearConversationModelMigration'
    | 'getAgentModelMigration'
    | 'markAgentModelMigrationSeen'
  >,
): ModelMigrationNoticeHandlers {
  return {
    getConversationNotice: withUser('conversation notice read', async (userId, req, res) => {
      const notice = await store.getConversationModelMigration(
        userId,
        param(req, 'conversationId'),
      );
      return res.json({ modelMigration: noticeView(notice) });
    }),

    clearConversationNotice: withUser('conversation notice clear', async (userId, req, res) => {
      await store.clearConversationModelMigration(userId, param(req, 'conversationId'));
      return res.status(204).end();
    }),

    getAgentNotice: withUser('agent notice read', async (userId, req, res) => {
      const notice = await store.getAgentModelMigration(param(req, 'id'), userId);
      return res.json({ modelMigration: noticeView(notice) });
    }),

    clearAgentNotice: withUser('agent notice clear', async (userId, req, res) => {
      await store.markAgentModelMigrationSeen(param(req, 'id'), userId);
      return res.status(204).end();
    }),
  };
}
