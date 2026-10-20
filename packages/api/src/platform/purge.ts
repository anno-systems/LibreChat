import { logger, tenantStorage } from '@librechat/data-schemas';
import type { TenantPurgeMethods, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AdminErasureContext, AdminErasureTarget } from '~/admin/users';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import { recordSystemAuditEntry } from '~/admin/audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { buildAuditContext } from '~/admin/context';
import { eraseUserData } from '~/user/erasure';

/**
 * Deletes a tenant's data in LibreChat (fork-only), for the operator API
 * (`DELETE /api/platform/tenants/:tenantId`). Each user's data goes through the same erasure
 * cascade as the admin user deletion (files in storage, shared links, MCP sessions, checkpoints);
 * then every document still carrying the tenant's id is deleted. The caller suspends the tenant
 * first, so nobody works in it meanwhile. A failed run can be repeated: users already erased are
 * gone and the sweep is idempotent.
 */

export interface TenantPurgeDeps {
  purge: TenantPurgeMethods;
  resolveErasure: (target: AdminErasureTarget) => Promise<AdminErasureContext>;
  deleteUserById: (userId: string) => Promise<unknown>;
  /** Drops cached configs and catalog endpoints of the tenant. */
  invalidate: (tenantId: string) => Promise<void>;
  recordAuditEntry?: RecordAuditEntry;
}

export interface TenantPurgeResult {
  users: number;
  documents: Record<string, number>;
}

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export async function purgeTenant(
  tenantId: string,
  deps: TenantPurgeDeps,
): Promise<TenantPurgeResult> {
  const users = await deps.purge.listTenantUserTargets(tenantId);
  for (const user of users) {
    await tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, async () => {
      const { deps: erasureDeps, checkpointer } = await deps.resolveErasure(user);
      await eraseUserData({ userId: user.id, tenantId, checkpointer }, erasureDeps);
      await deps.deleteUserById(user.id);
    });
  }
  const documents = await deps.purge.purgeTenantDocuments(tenantId);
  await deps.invalidate(tenantId);
  return { users: users.length, documents };
}

/**
 * `DELETE /api/platform/tenants/:tenantId` with `{ confirm: <tenantId> }`. Behind the operator
 * API token like the rest of `/api/platform`.
 */
export function createTenantPurgeHandler(
  deps: TenantPurgeDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function deleteTenant(req, res) {
    const tenantId = String((req.params as { tenantId?: string }).tenantId ?? '');
    if (!TENANT_ID.test(tenantId) || tenantId === '__SYSTEM__') {
      return res.status(400).json({ error: 'invalid_tenant' });
    }
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== tenantId) {
      return res.status(400).json({ error: 'confirmation_required' });
    }
    try {
      const result = await purgeTenant(tenantId, deps);
      const operator = req.get('X-Platform-Operator')?.trim();
      const input: RecordAuditEntryInput = {
        action: 'tenant.purged',
        outcome: 'success',
        severity: 'warning',
        // The tenant's own chain is gone with its data; the record stays on the platform chain.
        tenantId: undefined,
        actor: {
          type: 'service',
          id:
            operator && /^[A-Za-z0-9@._:-]{1,128}$/.test(operator) ? operator : 'platform-operator',
          name: 'Platform operator',
        },
        context: buildAuditContext(req as ServerRequest),
        target: { type: 'tenant', id: tenantId },
        metadata: {
          users: result.users,
          documents: Object.values(result.documents).reduce((sum, n) => sum + n, 0),
        },
      };
      await recordSystemAuditEntry(deps.recordAuditEntry, input, '[tenantPurge]');
      logger.warn(`[tenantPurge] tenant ${tenantId} purged: ${result.users} user(s)`);
      return res.json(result);
    } catch (error) {
      logger.error('[tenantPurge] purge failed', { tenantId, ...getSafeErrorMetadata(error) });
      return res.status(500).json({ error: 'purge_failed' });
    }
  };
}
