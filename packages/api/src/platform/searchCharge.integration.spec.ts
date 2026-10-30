import http from 'node:http';
import { logger } from '@librechat/data-schemas';
import { createSearchTool } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import { countFetchedPages } from './searchCharge';

/**
 * Runs the search library's own tool against a local stand-in for the search gateway, to pin what
 * the page charge relies on: the tool fetches the first 5 results (and, for news, up to 5 top
 * stories), and its artifact keeps no trace of which fetches returned text, so the charge counts
 * the pages the tool attempted, capped by the limit the gateway enforces.
 */
describe('pages the search tool fetches', () => {
  const searches: string[] = [];
  const scraped: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      const category = url.searchParams.get('categories') ?? '';
      searches.push(category);
      const pages =
        category === 'news'
          ? [1, 2, 3].map((n) => `https://pages.example/news/${n}`)
          : [1, 2, 3, 4, 5, 6, 7].map((n) => `https://pages.example/p${n}`);
      res.end(
        JSON.stringify({
          results: pages.map((page) => ({ url: page, title: page, content: `About ${page}` })),
        }),
      );
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const page = (JSON.parse(body) as { url: string }).url;
      scraped.push(page);
      if (page.endsWith('/p3')) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: 'page_limit_reached' }));
      } else if (page.endsWith('/p2')) {
        res.end(JSON.stringify({ markdown: '' }));
      } else {
        res.end(JSON.stringify({ markdown: 'First paragraph of the page.\n\nSecond paragraph.' }));
      }
    });
  });
  let base = '';
  /** The tool logs refused fetches as errors; this test expects them. */
  const quiet = Object.assign(Object.create(logger) as typeof logger, {
    error: () => quiet,
    warn: () => quiet,
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    searches.length = 0;
    scraped.length = 0;
  });

  async function runSearch(args: Record<string, unknown>) {
    const tool = createSearchTool({
      searchProvider: 'searxng',
      searxngInstanceUrl: base,
      searxngApiKey: 'key',
      scraperProvider: 'serper',
      serperApiKey: 'key',
      serperScraperOptions: { apiUrl: `${base}/scrape` },
      rerankerType: 'none',
      logger: quiet,
    });
    const message = await tool.invoke({ id: 'call_1', name: tool.name, args, type: 'tool_call' });
    return (message as { artifact?: Record<string, unknown> }).artifact?.web_search as {
      organic: Record<string, unknown>[];
    };
  }

  it('counts the pages the tool fetched; the artifact cannot tell which returned text', async () => {
    const result = await runSearch({ query: 'pages' });

    expect(searches).toEqual(['general']);
    expect(scraped).toHaveLength(5);
    expect(countFetchedPages(result, 10)).toBe(scraped.length);
    expect(countFetchedPages(result, 2)).toBe(2);
    // A page with text, one without and a refused one look alike.
    expect(result.organic.slice(0, 3).map((source) => Object.keys(source).sort())).toEqual([
      ['attribution', 'date', 'link', 'position', 'snippet', 'title'],
      ['attribution', 'date', 'link', 'position', 'snippet', 'title'],
      ['attribution', 'date', 'link', 'position', 'snippet', 'title'],
    ]);
  });

  it('sends a news call as a search of category news and also fetches its top stories', async () => {
    const result = await runSearch({ query: 'pages', news: true });

    expect(searches.sort()).toEqual(['general', 'news']);
    expect(scraped).toHaveLength(8);
    expect(countFetchedPages(result, 20, true)).toBe(scraped.length);
    expect(countFetchedPages(result, 20)).toBe(5);
  });
});
