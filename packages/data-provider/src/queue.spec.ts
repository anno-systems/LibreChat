import { providerLimitsSchema } from './queue';
import { configSchema } from './config';

const endpoint = {
  name: 'Mistral EU',
  apiKey: '${MISTRAL_API_KEY}',
  baseURL: 'https://api.mistral.ai/v1',
  models: { default: ['mistral-small-latest'] },
};

describe('provider limits', () => {
  it('are optional on a custom endpoint and kept when set', () => {
    const limits = { concurrency: 4, requestsPerMinute: 120, tokensPerMinute: 500_000 };
    const parsed = configSchema.parse({
      version: '1.3.0',
      endpoints: {
        custom: [
          { ...endpoint, limits },
          { ...endpoint, name: 'Other' },
        ],
      },
    });

    expect(parsed.endpoints?.custom?.[0]).toMatchObject({ limits });
    expect(parsed.endpoints?.custom?.[1]).not.toHaveProperty('limits');
  });

  it('refuse values that cannot be meant and fields they do not know', () => {
    for (const limits of [
      { concurrency: 0 },
      { tokensPerMinute: -1 },
      { requestsPerMinute: 2.5 },
      { maxWaitSeconds: 0 },
      { maxWaitSeconds: 3600 },
      { pauseSeconds: 301 },
      { queue: true },
    ]) {
      expect(providerLimitsSchema.safeParse(limits).success).toBe(false);
    }
    expect(providerLimitsSchema.safeParse({}).success).toBe(true);
  });
});
