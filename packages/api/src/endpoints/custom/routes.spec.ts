import { EModelEndpoint, endpointSchema } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getCustomEndpointConfig } from '~/app/config';
import { withModelRoute } from './routes';

const endpoint = {
  name: 'foundry',
  apiKey: 'key',
  baseURL: 'https://x.example/openai/v1',
  models: { default: ['chat', 'claude'] },
  addParams: { seed: 1 },
  dropParams: ['user'],
  modelRoutes: {
    claude: {
      baseURL: 'https://x.example/anthropic',
      provider: EModelEndpoint.anthropic,
      addParams: { top_k: 5 },
      dropParams: ['metadata'],
    },
  },
} as TEndpoint;

describe('withModelRoute', () => {
  it("applies the model's route over the endpoint's fields", () => {
    expect(withModelRoute(endpoint, 'claude')).toMatchObject({
      baseURL: 'https://x.example/anthropic',
      provider: EModelEndpoint.anthropic,
      addParams: { seed: 1, top_k: 5 },
      dropParams: ['metadata'],
    });
  });

  it('leaves the endpoint as it is for a model without a route or no model', () => {
    expect(withModelRoute(endpoint, 'chat')).toBe(endpoint);
    expect(withModelRoute(endpoint)).toBe(endpoint);
  });

  it('resolves through the custom endpoint lookup only when the model is named', () => {
    const appConfig = { endpoints: { custom: [endpoint] } } as unknown as AppConfig;
    expect(getCustomEndpointConfig({ endpoint: 'foundry', appConfig })?.baseURL).toBe(
      'https://x.example/openai/v1',
    );
    expect(
      getCustomEndpointConfig({ endpoint: 'foundry', appConfig, model: 'claude' })?.provider,
    ).toBe(EModelEndpoint.anthropic);
  });

  it('is a field librechat.yaml accepts, with only the routed fields', () => {
    expect(endpointSchema.safeParse(endpoint).success).toBe(true);
    const extra = { ...endpoint, modelRoutes: { claude: { apiKey: 'other' } } };
    expect(endpointSchema.safeParse(extra).success).toBe(false);
  });
});
