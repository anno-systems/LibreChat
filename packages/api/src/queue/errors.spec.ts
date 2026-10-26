import { getProviderRateLimit, isProviderQueueTimeout, parseRetryAfter } from './errors';
import { ProviderQueueTimeoutError } from './errors';

const NOW = Date.parse('2026-10-26T10:00:00Z');

describe('provider rate limit detection', () => {
  it('recognizes a 429 and reads its Retry-After in seconds', () => {
    const error = Object.assign(new Error('429'), {
      status: 429,
      headers: { 'Retry-After': '7' },
    });
    expect(getProviderRateLimit(error, NOW)).toEqual({ retryAfterMs: 7_000 });
  });

  it('reads Retry-After-Ms and HTTP dates, from Headers objects as well', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '1500' }), NOW)).toBe(1_500);
    expect(parseRetryAfter({ 'retry-after': new Date(NOW + 4_000).toUTCString() }, NOW)).toBe(
      4_000,
    );
    expect(parseRetryAfter({ 'retry-after': 'soon' }, NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
  });

  it('caps a Retry-After at fifteen minutes', () => {
    expect(parseRetryAfter({ 'retry-after': '86400' }, NOW)).toBe(15 * 60_000);
  });

  it("recognizes LangChain's MODEL_RATE_LIMIT classification on a wrapped cause", () => {
    const cause = new Error(
      'Rate limited Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/',
    );
    const error = new Error('graph failed', { cause });
    expect(getProviderRateLimit(error, NOW)).toEqual({});
  });

  it('does not treat other failures or an exhausted quota as a rate limit', () => {
    expect(getProviderRateLimit(Object.assign(new Error('bad'), { status: 400 }), NOW)).toBe(
      undefined,
    );
    expect(
      getProviderRateLimit(
        Object.assign(new Error('quota'), { status: 429, error: { code: 'insufficient_quota' } }),
        NOW,
      ),
    ).toBeUndefined();
    expect(getProviderRateLimit('429', NOW)).toBeUndefined();
  });

  it('identifies a queue timeout by class or code', () => {
    expect(isProviderQueueTimeout(new ProviderQueueTimeoutError('x', 1))).toBe(true);
    expect(isProviderQueueTimeout({ code: 'QUEUE_TIMEOUT' })).toBe(true);
    expect(isProviderQueueTimeout(new Error('QUEUE_TIMEOUT'))).toBe(false);
  });
});
