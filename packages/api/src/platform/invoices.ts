import { logger } from '@librechat/data-schemas';
import type { PlatformInvoices } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * The operator's monthly statement (fork-only): `GET /api/platform/invoices?month=YYYY-MM`
 * (`PLATFORM_API_TOKEN`), one row per tenant with what it was charged for tokens, web searches and
 * fetched pages, what the tokens cost at the providers' rates, and its MCP subscriptions of that
 * month, together with the display currency. Without `month`, the current month (UTC).
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface PlatformInvoiceDeps {
  getPlatformInvoices(input: { month: string }): Promise<PlatformInvoices>;
  /** The display currency: its code and how many units one USD is. */
  currency(): { code: string; rate: number } | undefined;
}

export function createPlatformInvoiceHandler(
  deps: PlatformInvoiceDeps,
): (req: Request, res: Response) => Promise<Response> {
  return async (req, res) => {
    const raw = (req.query as { month?: unknown }).month;
    const month = raw === undefined ? new Date().toISOString().slice(0, 7) : raw;
    if (typeof month !== 'string' || !MONTH.test(month)) {
      return res.status(400).json({ error: 'invalid_month' });
    }
    try {
      const invoices = await deps.getPlatformInvoices({ month });
      return res.json({ ...invoices, currency: deps.currency() ?? null });
    } catch (error) {
      logger.error('[platformInvoices] Failed to load the statement', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'internal_error' });
    }
  };
}
