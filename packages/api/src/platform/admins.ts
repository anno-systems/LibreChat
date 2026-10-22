import { z } from 'zod';
import { SystemRoles } from 'librechat-data-provider';
import { logger, tenantStorage } from '@librechat/data-schemas';
import type { AuditMetadata, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import { recordSystemAuditEntry } from '~/admin/audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { buildAuditContext } from '~/admin/context';
import { operatorActor } from './handlers';

/**
 * The operator sets a tenant user's admin role (fork-only), for the operator API
 * (`PUT /api/platform/tenants/:tenantId/admins/:subject`). The admin app changes the identity
 * provider's grant itself; this applies it to the LibreChat user at once instead of at the next
 * OpenID sign-in, and records it in the tenant's own audit chain so the customer sees what the
 * operator did. A user who never signed in is not created: the sign-in applies the grant then.
 */

export interface TenantAdminUser {
  _id: unknown;
  role?: string;
}

export interface TenantAdminDeps {
  /** Looks the user up by OpenID subject; the criteria name the tenant. */
  findUser(
    criteria: { openidId: string; tenantId: string },
    fields: string,
  ): Promise<TenantAdminUser | null>;
  /**
   * Sets the role while the user still matches `expectedState`, and evicts the user's cached
   * auth documents (`updateUser` of data-schemas does both). Null when the state moved.
   */
  updateUser(
    userId: string,
    data: { role: string },
    expectedState: { tenantId: string; role?: string },
    options: { preserveExpiresAt: boolean },
  ): Promise<TenantAdminUser | null>;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

export interface TenantAdminResult {
  found: boolean;
  role: string | null;
  changed: boolean;
  userId?: string;
  previousRole?: string;
}

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SUBJECT = /^[A-Za-z0-9_-]{1,128}$/;

const bodySchema = z
  .object({ admin: z.boolean(), email: z.string().trim().email().max(254).optional() })
  .strict();

/** The role the user should have, or undefined when the change leaves it as it is. */
function targetRole(admin: boolean, current: string | undefined): string | undefined {
  if (admin) return current === SystemRoles.ADMIN ? undefined : SystemRoles.ADMIN;
  return current === SystemRoles.ADMIN ? SystemRoles.USER : undefined;
}

/** Applies the admin flag to the tenant's user with that OpenID subject, if one exists. */
export async function setTenantAdmin(
  input: { tenantId: string; subject: string; admin: boolean },
  deps: Pick<TenantAdminDeps, 'findUser' | 'updateUser'>,
): Promise<TenantAdminResult> {
  const { tenantId, subject, admin } = input;
  return tenantStorage.run({ ...tenantStorage.getStore(), tenantId }, async () => {
    const user = await deps.findUser({ openidId: subject, tenantId }, '_id role');
    if (!user) return { found: false, role: null, changed: false };
    const userId = String(user._id);
    const previousRole = user.role;
    const role = targetRole(admin, previousRole);
    const base = { found: true, userId, ...(previousRole && { previousRole }) };
    if (!role) return { ...base, role: previousRole ?? null, changed: false };
    const updated = await deps.updateUser(
      userId,
      { role },
      { tenantId, ...(previousRole && { role: previousRole }) },
      { preserveExpiresAt: true },
    );
    if (updated) return { ...base, role: updated.role ?? role, changed: true };
    // The role moved meanwhile; report what the user has now.
    const current = await deps.findUser({ openidId: subject, tenantId }, '_id role');
    return { ...base, role: current?.role ?? null, changed: false };
  });
}

/** `PUT /api/platform/tenants/:tenantId/admins/:subject` with `{ admin, email? }`. */
export function createTenantAdminHandler(
  deps: TenantAdminDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function putTenantAdmin(req, res) {
    const params = req.params as { tenantId?: string; subject?: string };
    const tenantId = String(params.tenantId ?? '');
    const subject = String(params.subject ?? '');
    const parsed = bodySchema.safeParse(req.body);
    if (
      !TENANT_ID.test(tenantId) ||
      tenantId === '__SYSTEM__' ||
      !SUBJECT.test(subject) ||
      !parsed.success
    ) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const { admin, email } = parsed.data;
    try {
      const result = await setTenantAdmin({ tenantId, subject, admin }, deps);
      const metadata: AuditMetadata = {
        subject,
        viaPlatform: true,
        changed: result.changed,
        ...(result.userId && { userId: result.userId }),
        ...(result.found && { previousRole: result.previousRole ?? null }),
        ...(email && { email }),
      };
      const entry: RecordAuditEntryInput = {
        action: admin ? 'role.member_added' : 'role.member_removed',
        outcome: 'success',
        severity: 'critical',
        tenantId,
        actor: operatorActor(req),
        context: buildAuditContext(req as ServerRequest),
        target: { type: 'role', id: SystemRoles.ADMIN, name: SystemRoles.ADMIN },
        metadata,
      };
      if (deps.auditFailClosed && deps.recordAuditEntry) {
        await deps.recordAuditEntry(entry, { failClosed: true });
      } else {
        await recordSystemAuditEntry(deps.recordAuditEntry, entry, '[platformAdmins]');
      }
      return res.json({ found: result.found, role: result.role });
    } catch (error) {
      logger.error('[platformAdmins] admin role update failed', {
        tenantId,
        ...getSafeErrorMetadata(error),
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
