import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { RecordAuditEntry } from './audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAdminAuditEmitter } from './audit';

/**
 * Audit of password resets the admin app sent (fork-only). The reset itself happens at the
 * identity provider, which LibreChat does not see; the admin app reports it here right after the
 * provider accepted it, so the tenant's audit chain names the admin who sent it.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/;

/** Stable code for a user that is not in the admin's tenant. */
export const USER_NOT_FOUND = 'user_not_found';

export interface AdminPasswordResetDeps {
  /** Tenant-scoped user lookup (data-schemas' `getUserById`). */
  getUserById: (userId: string, fieldsToSelect?: string) => Promise<{ _id: unknown } | null>;
  recordAuditEntry: RecordAuditEntry;
}

export function createAdminPasswordResetHandler(
  deps: AdminPasswordResetDeps,
): (req: ServerRequest, res: Response) => Promise<Response> {
  /** Always fail-closed: the entry is the whole point of the request, so a 204 means it is stored. */
  const emitAudit = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: true,
    logPrefix: '[adminPasswordReset]',
  });

  /**
   * POST /api/admin/users/:id/password-reset-events — no body. Records `user.password_reset_sent`
   * with the calling admin as actor and the user as target, and answers 204; a user outside the
   * caller's tenant answers 404 `user_not_found`.
   */
  return async function recordPasswordResetSent(
    req: ServerRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { id } = req.params as { id?: string };
      const user =
        typeof id === 'string' && OBJECT_ID.test(id) ? await deps.getUserById(id, '_id') : null;
      if (!user) {
        return res.status(404).json({ error: 'User not found', code: USER_NOT_FOUND });
      }
      await emitAudit(req, {
        action: 'user.password_reset_sent',
        target: { type: 'user', id: id as string },
      });
      return res.status(204).end();
    } catch (error) {
      logger.error('[adminPasswordReset] record error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to record the password reset' });
    }
  };
}
