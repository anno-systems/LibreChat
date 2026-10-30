import crypto from 'node:crypto';
import { DEFAULT_MAX_PAGES_PER_SEARCH } from '@librechat/data-schemas';

/**
 * The request's tenant in web search credentials (fork-only). A deployment that meters one search
 * account per tenant, such as the platform's search gateway, writes `{{LIBRECHAT_TENANT_ID}}` into
 * a key or URL (`SEARCH_GATEWAY_KEY=<secret>:{{LIBRECHAT_TENANT_ID}}`) and receives each request
 * with the caller's tenant in its place, so no tenant needs keys of its own. Without a tenant, or
 * with one that is not a plain id, the placeholder stays and the service refuses the request.
 *
 * A gateway that limits the pages one search fetches also reads the search run: each loaded web
 * search tool has its own random id in `{{LIBRECHAT_SEARCH_RUN}}` and its page limit (the
 * operator's cap for the tenant, lowered by the scope's `webSearch.maxPagesPerSearch`) in
 * `{{LIBRECHAT_SEARCH_PAGES}}`. The search tool sends every search and page fetch of the tool with
 * the same key, so the gateway can count the pages of each search and refuse those over the limit.
 * Without a run, both placeholders stay as written.
 */
export const TENANT_PLACEHOLDER = '{{LIBRECHAT_TENANT_ID}}';
export const SEARCH_RUN_PLACEHOLDER = '{{LIBRECHAT_SEARCH_RUN}}';
export const SEARCH_PAGES_PLACEHOLDER = '{{LIBRECHAT_SEARCH_PAGES}}';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** One web search tool's run: the id its requests carry and the pages each search may fetch. */
export interface SearchRun {
  id: string;
  pages: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fill(
  values: Record<string, unknown>,
  replacements: readonly [string, string][],
): Record<string, unknown> {
  const entries = Object.entries(values).map(([key, value]) => {
    if (typeof value === 'string') {
      return [key, replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value)];
    }
    /** Nested options carry keys too (`keenableScraperOptions.apiKey`). */
    return [key, isPlainObject(value) ? fill(value, replacements) : value];
  });
  return Object.fromEntries(entries);
}

function isPageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The most pages one search may fetch: the operator's cap, lowered by the scope's configured
 * value. A missing or invalid value does not count; without either it is 5, what the search tool
 * fetches today.
 */
export function getSearchPageLimit(operatorCap?: unknown, configured?: unknown): number {
  const cap = isPageCount(operatorCap) ? operatorCap : DEFAULT_MAX_PAGES_PER_SEARCH;
  return isPageCount(configured) ? Math.min(cap, configured) : cap;
}

/**
 * A new run for one web search tool: a random id and the page limit of `getSearchPageLimit`, from
 * the operator's cap for the tenant and the request config's `webSearch.maxPagesPerSearch`.
 */
export function createSearchRun({
  operatorCap,
  configured,
}: {
  operatorCap?: unknown;
  configured?: unknown;
} = {}): SearchRun {
  return {
    id: crypto.randomBytes(16).toString('base64url'),
    pages: getSearchPageLimit(operatorCap, configured),
  };
}

export function withTenantId<T extends object>(values: T, tenantId: string | undefined): T {
  return withSearchCredentials(values, { tenantId });
}

/** Fills the tenant and, with a run, the run id and page limit into keys and URLs. */
export function withSearchCredentials<T extends object>(
  values: T,
  { tenantId, run }: { tenantId?: string; run?: SearchRun },
): T {
  const replacements: [string, string][] = [];
  if (tenantId && TENANT_ID.test(tenantId)) {
    replacements.push([TENANT_PLACEHOLDER, tenantId]);
  }
  if (run && RUN_ID.test(run.id) && isPageCount(run.pages)) {
    replacements.push(
      [SEARCH_RUN_PLACEHOLDER, run.id],
      [SEARCH_PAGES_PLACEHOLDER, String(run.pages)],
    );
  }
  if (replacements.length === 0) {
    return values;
  }
  return fill(values as Record<string, unknown>, replacements) as T;
}
