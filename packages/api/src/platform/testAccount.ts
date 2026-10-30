import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import type { RecordAuditEntryInput } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { RecordAuditEntry } from '~/admin/audit';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';
import { buildAuditContext } from '~/admin/context';
import { operatorActor } from './handlers';

/**
 * Records in a tenant's own audit chain that the operator opened the tenant with its platform
 * test account (fork-only), for the operator API
 * (`POST /api/platform/tenants/:tenantId/audit/test-account-opened`). The admin app sets the
 * account's password in the identity provider and calls this before it hands the password out,
 * so the customer sees every opening. The write always fails closed: the answer is the record.
 */

export interface TestAccountAuditDeps {
  recordAuditEntry?: RecordAuditEntry;
}

const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const bodySchema = z
  .object({
    /** What the operator signs in with; never a password. */
    loginName: z.string().trim().email().max(254),
    /** The account was created by this opening rather than found. */
    created: z.boolean().optional(),
  })
  .strict();

/** `POST /api/platform/tenants/:tenantId/audit/test-account-opened` with `{ loginName, created? }`. */
export function createTestAccountAuditHandler(
  deps: TestAccountAuditDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async function postTestAccountOpened(req, res) {
    const tenantId = String((req.params as { tenantId?: string }).tenantId ?? '');
    const parsed = bodySchema.safeParse(req.body);
    if (!TENANT_ID.test(tenantId) || tenantId === '__SYSTEM__' || !parsed.success) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (!deps.recordAuditEntry) {
      return res.status(503).json({ error: 'audit_unavailable' });
    }
    const { loginName, created } = parsed.data;
    const entry: RecordAuditEntryInput = {
      action: 'tenant.test_account_opened',
      outcome: 'success',
      severity: 'warning',
      tenantId,
      actor: operatorActor(req),
      context: buildAuditContext(req as ServerRequest),
      target: { type: 'test_account', id: loginName, name: loginName },
      metadata: { viaPlatform: true, ...(created !== undefined && { created }) },
    };
    try {
      await deps.recordAuditEntry(entry, { failClosed: true });
      return res.status(201).json({ recorded: true });
    } catch (error) {
      logger.error('[platformTestAccount] audit write failed', {
        tenantId,
        ...getSafeErrorMetadata(error),
      });
      return res.status(500).json({ error: 'audit_failed' });
    }
  };
}
