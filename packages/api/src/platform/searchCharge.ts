import { logger, WEB_SEARCH_CONTEXT } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

/**
 * Charges a web search to the user's balance (fork-only): one ledger transaction of context
 * `web_search` per completed search, at the operator's price for the tenant
 * (`searchPer1000`, `platformPricing`). Without a search price nothing is written, as upstream.
 * Failures are logged, never thrown: the search already ran and its answer still reaches the user.
 */

export interface WebSearchChargeDeps {
  /** Credits one search costs the tenant; 0 when no price is set. */
  webSearchCredits(tenantId?: string): number;
  createTransaction(tx: {
    user: string;
    tokenType: 'credits';
    context: string;
    rawAmount: number;
    conversationId?: string;
    balance?: { enabled?: boolean };
    transactions?: { enabled?: boolean };
  }): Promise<unknown>;
}

export interface WebSearchChargeRequest {
  user?: { id?: string; tenantId?: string };
  config?: {
    balance?: { enabled?: boolean };
    transactions?: { enabled?: boolean };
  };
}

export type WebSearchCharge = (
  req: WebSearchChargeRequest,
  conversationId?: string,
) => Promise<void>;

export function createWebSearchCharge(deps: WebSearchChargeDeps): WebSearchCharge {
  return async (req, conversationId) => {
    const user = req.user?.id;
    if (!user) {
      return;
    }
    const credits = deps.webSearchCredits(req.user?.tenantId);
    if (!(credits > 0)) {
      return;
    }
    try {
      await deps.createTransaction({
        user,
        tokenType: 'credits',
        context: WEB_SEARCH_CONTEXT,
        rawAmount: -credits,
        ...(conversationId && { conversationId }),
        balance: req.config?.balance,
        transactions: req.config?.transactions,
      });
    } catch (error) {
      logger.error('[webSearchCharge] Failed to charge a web search', getSafeErrorMetadata(error));
    }
  };
}
