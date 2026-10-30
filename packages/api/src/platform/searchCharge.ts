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
 * Fetched pages are counted from the tool's `web_search` artifact (`countFetchedPages`): the pages
 * the tool attempted, never more than the page limit of the search (the operator's cap, lowered by
 * `webSearch.maxPagesPerSearch` of the request's config), twice that for a call with news
 * (`isNewsSearch`), which is what the search gateway lets through.
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
  /** The tool call's arguments (an object or its JSON), which say whether it searched news. */
  input?: unknown,
) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Pages the search tool fetches per list (`maxSources` of `@librechat/agents`, not settable). */
export const TOOL_PAGES_PER_LIST = 5;

function distinctLinks(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const links = new Set<string>();
  for (const source of list) {
    if (isRecord(source) && typeof source.link === 'string' && source.link !== '') {
      links.add(source.link);
    }
  }
  return [...links];
}

/**
 * The pages a search fetched, from its `web_search` artifact. The artifact cannot tell a fetched
 * page from a refused or failed one: the search tool strips each source's highlights and content
 * before returning it (`formatResultsForLLM` of `@librechat/agents`). So this counts the pages the
 * tool attempted, as it picks them: the first 5 distinct `organic` links and, for a news call, the
 * first 5 `topStories` links that are no organic result. The search gateway lets through exactly
 * `limit` of those and refuses the rest, so the charge is the smaller of the two: every page the
 * gateway let through, including pages that returned no text or failed upstream, and no refused
 * page.
 */
export function countFetchedPages(result: unknown, limit: number, news = false): number {
  if (!isRecord(result) || !(limit > 0)) {
    return 0;
  }
  const organic = distinctLinks(result.organic);
  const organicSet = new Set(organic);
  const stories = news
    ? distinctLinks(
        Array.isArray(result.topStories)
          ? result.topStories.slice(0, TOOL_PAGES_PER_LIST)
          : undefined,
      ).filter((link) => !organicSet.has(link))
    : [];
  const attempted =
    Math.min(organic.length, TOOL_PAGES_PER_LIST) + Math.min(stories.length, TOOL_PAGES_PER_LIST);
  return Math.min(attempted, limit);
}

/**
 * Whether the call searched news (its arguments, an object or their JSON, say `news: true`), which
 * doubles its page limit as the gateway doubles it. Without arguments the call counts as one
 * without news, so it is never charged more than the plain limit.
 */
export function isNewsSearch(input?: unknown): boolean {
  let args = input;
  if (typeof input === 'string') {
    try {
      args = JSON.parse(input);
    } catch {
      return false;
    }
  }
  return isRecord(args) && args.news === true;
}

export function createWebSearchCharge(deps: WebSearchChargeDeps): WebSearchCharge {
  return async (req, conversationId, result, input) => {
    const user = req.user?.id;
    if (!user) {
      return;
    }
    const tenantId = req.user?.tenantId;
    const searchCredits = deps.webSearchCredits(tenantId);
    const fetchCredits = deps.webFetchCredits?.(tenantId) ?? 0;
    const news = isNewsSearch(input);
    const limit = getSearchPageLimit(
      deps.maxPagesPerSearch?.(tenantId),
      req.config?.webSearch?.maxPagesPerSearch,
    );
    const pages = fetchCredits > 0 ? countFetchedPages(result, news ? limit * 2 : limit, news) : 0;
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
