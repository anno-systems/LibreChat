import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { RecordAuditEntry } from './audit';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAdminAuditEmitter } from './audit';

/**
 * Admin access to one user's credit balance (fork-only). Upstream keeps balances CLI-only
 * (`config/set-balance.js`); these handlers let a tenant admin read and set the balance of a
 * user in their own tenant. Tenant isolation scopes both the user lookup and the balance record.
 */

/** Upper bound for a balance an admin sets, far above any refill amount in practice. */
const MAX_TOKEN_CREDITS = 1_000_000_000_000;
const OBJECT_ID = /^[0-9a-f]{24}$/;

/** The balance fields these handlers read, as data-schemas' balance methods return them. */
export interface BalanceRecord {
  tokenCredits: number;
  autoRefillEnabled?: boolean;
  refillAmount?: number;
  refillIntervalValue?: number;
  refillIntervalUnit?: string;
  lastRefill?: Date;
}

export interface AdminBalanceDeps {
  getUserById: (userId: string, fieldsToSelect?: string) => Promise<{ _id: unknown } | null>;
  findBalanceByUser: (userId: string) => Promise<BalanceRecord | null>;
  upsertBalanceFields: (
    userId: string,
    fields: { tokenCredits: number },
  ) => Promise<BalanceRecord | null>;
  /** Adds credits atomically against concurrent spending (data-schemas' `updateBalance`). */
  updateBalance: (update: { user: string; incrementValue: number }) => Promise<BalanceRecord>;
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

/** The balance as the admin API returns it; `tokenCredits` is null before the first record. */
export interface AdminBalanceView {
  tokenCredits: number | null;
  autoRefillEnabled: boolean;
  refillAmount?: number;
  refillIntervalValue?: number;
  refillIntervalUnit?: string;
  lastRefill?: Date;
}

function toView(balance: BalanceRecord | null): AdminBalanceView {
  if (!balance) {
    return { tokenCredits: null, autoRefillEnabled: false };
  }
  return {
    tokenCredits: balance.tokenCredits,
    autoRefillEnabled: balance.autoRefillEnabled === true,
    refillAmount: balance.refillAmount,
    refillIntervalValue: balance.refillIntervalValue,
    refillIntervalUnit: balance.refillIntervalUnit,
    lastRefill: balance.lastRefill,
  };
}

export function createAdminBalanceHandlers(deps: AdminBalanceDeps): {
  getUserBalance: (req: ServerRequest, res: Response) => Promise<Response>;
  setUserBalance: (req: ServerRequest, res: Response) => Promise<Response>;
  addUserCredits: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const { getUserById, findBalanceByUser, upsertBalanceFields, updateBalance } = deps;
  const emitAudit = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[adminBalance]',
  });

  /** Resolves `:id` to a user of the caller's tenant; answers 400 or 404 otherwise. */
  async function resolveUser(req: ServerRequest, res: Response): Promise<string | null> {
    const { id } = req.params as { id?: string };
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      res.status(400).json({ error: 'Invalid user id' });
      return null;
    }
    const user = await getUserById(id, '_id');
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    return id;
  }

  /** GET /api/admin/users/:id/balance */
  async function getUserBalance(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const userId = await resolveUser(req, res);
      if (!userId) {
        return res;
      }
      return res.status(200).json({ balance: toView(await findBalanceByUser(userId)) });
    } catch (error) {
      logger.error('[adminBalance] getUserBalance error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to read balance' });
    }
  }

  /** PUT /api/admin/users/:id/balance — body `{ tokenCredits }`, a whole number of credits. */
  async function setUserBalance(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { tokenCredits } = (req.body ?? {}) as { tokenCredits?: unknown };
      if (
        typeof tokenCredits !== 'number' ||
        !Number.isInteger(tokenCredits) ||
        tokenCredits < 0 ||
        tokenCredits > MAX_TOKEN_CREDITS
      ) {
        return res.status(400).json({ error: 'tokenCredits must be a whole number of credits' });
      }
      const userId = await resolveUser(req, res);
      if (!userId) {
        return res;
      }
      const before = await findBalanceByUser(userId);
      const balance = await upsertBalanceFields(userId, { tokenCredits });
      await emitAudit(req, {
        action: 'user.balance_updated',
        target: { type: 'user', id: userId },
        metadata: { previous: before?.tokenCredits ?? null, tokenCredits },
      });
      return res.status(200).json({ balance: toView(balance) });
    } catch (error) {
      logger.error('[adminBalance] setUserBalance error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to set balance' });
    }
  }

  /**
   * POST /api/admin/users/:id/balance/credits — body `{ amount }`, whole credits to add on top of
   * what the user has, so a top-up never loses what the user spends meanwhile.
   */
  async function addUserCredits(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { amount } = (req.body ?? {}) as { amount?: unknown };
      if (
        typeof amount !== 'number' ||
        !Number.isInteger(amount) ||
        amount < 1 ||
        amount > MAX_TOKEN_CREDITS
      ) {
        return res.status(400).json({ error: 'amount must be a whole number of credits above 0' });
      }
      const userId = await resolveUser(req, res);
      if (!userId) {
        return res;
      }
      const balance = await updateBalance({ user: userId, incrementValue: amount });
      await emitAudit(req, {
        action: 'user.balance_updated',
        target: { type: 'user', id: userId },
        metadata: { added: amount, tokenCredits: balance.tokenCredits },
      });
      return res.status(200).json({ balance: toView(balance) });
    } catch (error) {
      logger.error('[adminBalance] addUserCredits error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to add credits' });
    }
  }

  return { getUserBalance, setUserBalance, addUserCredits };
}
