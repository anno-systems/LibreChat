import { EModelEndpoint, endpointSchema } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { withModelRoute, withoutForeignParams } from './routes';
import { getCustomEndpointConfig } from '~/app/config';
import { loadCustomEndpointsConfig } from './config';

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

describe('withoutForeignParams', () => {
  const kept = {
    model: 'm',
    user: 'u',
    temperature: 0.2,
    stop: ['x'],
    frequency_penalty: 1,
    presence_penalty: 1,
    logit_bias: { 1: 1 },
    n: 2,
    max_tokens: 10,
    reasoning_effort: 'high',
    topK: 5,
    topP: 0.5,
    maxOutputTokens: 10,
    thinking: true,
    thinkingBudget: 100,
    promptCache: true,
  };

  it('gives the Anthropic API no OpenAI-only field', () => {
    expect(
      Object.keys(withoutForeignParams({ ...endpoint, provider: EModelEndpoint.anthropic }, kept)),
    ).toEqual([
      'model',
      'user',
      'temperature',
      'stop',
      'topK',
      'topP',
      'maxOutputTokens',
      'thinking',
      'thinkingBudget',
      'promptCache',
    ]);
  });

  it("gives OpenAI's APIs no Anthropic-only field, and OpenRouter its prompt caching", () => {
    expect(Object.keys(withoutForeignParams(endpoint, kept))).toEqual([
      'model',
      'user',
      'temperature',
      'stop',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'n',
      'max_tokens',
      'reasoning_effort',
    ]);
    const openRouter = {
      ...endpoint,
      customParams: { defaultParamsEndpoint: 'openrouter' },
    } as TEndpoint;
    expect(withoutForeignParams(openRouter, kept)).toHaveProperty('promptCache', true);
  });

  it('leaves an endpoint without routes as upstream builds it', () => {
    const { modelRoutes: _routes, ...plain } = endpoint;
    expect(withoutForeignParams({ ...plain, provider: EModelEndpoint.anthropic }, kept)).toBe(kept);
  });
});

describe('modelParamsEndpoints in /api/endpoints', () => {
  it('names the parameter set of each model routed to another API, and no URL or key', () => {
    const config = loadCustomEndpointsConfig([endpoint]);
    expect(config?.foundry?.modelParamsEndpoints).toEqual({ claude: EModelEndpoint.anthropic });
    expect(JSON.stringify(config)).not.toContain('x.example');
  });
});
