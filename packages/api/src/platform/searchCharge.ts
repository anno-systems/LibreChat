import { logger, WEB_FETCH_CONTEXT, WEB_SEARCH_CONTEXT } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getSearchPageLimit } from '~/web/tenant';

/**
 * Charges a web search to the user's balance (fork-only): one ledger transaction of context
 * `web_search` per completed search, at the operator's price for the tenant (`searchPer1000`,
 * `platformPricing`), and one of context `web_scrape` per page the search fetched, at the
 * operator's page price (`fetchPer1000`). Without a price nothing is written for it, as upstream.
 * Failures are logged, never thrown: the search already ran and its answer still reaches the user.
 *
 * Fetched pages are counted from the tool's `web_search` artifact (`countFetchedPages`), never more
 * than the page limit of the search (the operator's cap, lowered by `webSearch.maxPagesPerSearch`
 * of the request's config), which the search gateway enforces as well.
 */

export interface WebSearchChargeDeps {
  /** Credits one search costs the tenant; 0 when no price is set. */
  webSearchCredits(tenantId?: string): number;
  /** Credits one fetched page costs the tenant; 0 when no price is set. */
  webFetchCredits?(tenantId?: string): number;
  /** The operator's cap on pages per search for the tenant. */
  maxPagesPerSearch?(tenantId?: string): number;
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
    webSearch?: { maxPagesPerSearch?: number };
  };
}

export type WebSearchCharge = (
  req: WebSearchChargeRequest,
  conversationId?: string,
  /** The tool's `web_search` artifact, whose sources show the pages fetched. */
  result?: unknown,
) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The pages a search fetched, from its `web_search` artifact: each distinct link among `organic`
 * and `topStories` whose source carries highlights, which the search tool adds only to a page it
 * fetched and found text in. Snippet-only results, refused or failed fetches and fetched pages
 * without text do not count. Never more than `limit`.
 */
export function countFetchedPages(result: unknown, limit: number): number {
  if (!isRecord(result) || !(limit > 0)) {
    return 0;
  }
  const links = new Set<string>();
  for (const list of [result.organic, result.topStories]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const source of list) {
      if (
        isRecord(source) &&
        typeof source.link === 'string' &&
        Array.isArray(source.highlights) &&
        source.highlights.length > 0
      ) {
        links.add(source.link);
      }
    }
  }
  return Math.min(links.size, limit);
}

export function createWebSearchCharge(deps: WebSearchChargeDeps): WebSearchCharge {
  return async (req, conversationId, result) => {
    const user = req.user?.id;
    if (!user) {
      return;
    }
    const tenantId = req.user?.tenantId;
    const searchCredits = deps.webSearchCredits(tenantId);
    const fetchCredits = deps.webFetchCredits?.(tenantId) ?? 0;
    const pages =
      fetchCredits > 0
        ? countFetchedPages(
            result,
            getSearchPageLimit(
              deps.maxPagesPerSearch?.(tenantId),
              req.config?.webSearch?.maxPagesPerSearch,
            ),
          )
        : 0;
    const debits: [string, number][] = [
      ...(searchCredits > 0 ? [[WEB_SEARCH_CONTEXT, searchCredits] as [string, number]] : []),
      ...Array.from({ length: pages }, () => [WEB_FETCH_CONTEXT, fetchCredits] as [string, number]),
    ];
    for (const [context, credits] of debits) {
      try {
        await deps.createTransaction({
          user,
          tokenType: 'credits',
          context,
          rawAmount: -credits,
          ...(conversationId && { conversationId }),
          balance: req.config?.balance,
          transactions: req.config?.transactions,
        });
      } catch (error) {
        logger.error('[webSearchCharge] Failed to charge a web search', {
          context,
          ...getSafeErrorMetadata(error),
        });
      }
    }
  };
}
