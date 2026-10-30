import { HumanMessage } from '@langchain/core/messages';
import { Providers, getChatModelClass } from '@librechat/agents';
import type { AppConfig, PlatformProvider } from '@librechat/data-schemas';
import type { ProviderInitializeParams } from '~/types';
import { getProviderConfig } from '~/endpoints/config/providers';
import { queueKey, resolveModelLimits } from '~/queue/turn';
import { catalogEndpoints } from './catalog';

/**
 * The owner's Azure AI Foundry resource: one key, four models on three base URLs and three APIs.
 * Each model is resolved and initialized the way a chat turn does it (`getProviderConfig`, then
 * `initializeCustom`), handed to the agents SDK's real client, and invoked; only the HTTP
 * request leaves the process, and the fake `fetch` records it.
 */

const KEY = 'azure-foundry-key-0123456789';
const SERVICES = 'https://anno-systems-westeurope.services.ai.azure.com';

const foundry: PlatformProvider = {
  name: 'azure-foundry',
  label: 'Azure AI Foundry',
  baseURL: `${SERVICES}/openai/v1`,
  apiKey: `enc:${KEY}`,
  location: { type: 'global' },
  models: [
    { id: 'mistral-medium-3-5', api: 'chat', limits: { tokensPerMinute: 20000 } },
    {
      id: 'Mistral-Large-3',
      api: 'chat',
      baseURL: 'https://anno-systems-westeurope.openai.azure.com/openai/v1',
    },
    { id: 'gpt-6.1-terra', api: 'responses' },
    { id: 'claude-sonnet-5-5', api: 'anthropic', baseURL: `${SERVICES}/anthropic/v1` },
  ],
};

const decrypt = (value: string) => value.replace(/^enc:/, '');

function appConfigOf(provider: PlatformProvider): AppConfig {
  const custom = catalogEndpoints('tenant-a', null, [{ ...provider, allTenants: true }], decrypt);
  return { endpoints: { custom } } as unknown as AppConfig;
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let captured: Captured[] = [];
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  captured = [];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    captured.push({ url: request.url, headers, body: JSON.parse(await request.text()) });
    return new Response(JSON.stringify({ error: { message: 'stop here' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

/** Resolves and initializes `model` like a chat turn, then sends one message through the SDK. */
async function send(appConfig: AppConfig, model: string, parameters: Record<string, unknown> = {}) {
  const { getOptions, overrideProvider } = getProviderConfig({
    provider: 'azure-foundry',
    appConfig,
    model,
  });
  const options = await getOptions({
    runtime: { appConfig, user: { id: 'user-1' }, requestBody: {} },
    endpoint: 'azure-foundry',
    model_parameters: { model, ...parameters },
    db: { getUserKeyValues: jest.fn() },
  } as unknown as ProviderInitializeParams);
  const provider = (options.provider ?? overrideProvider) as Providers;
  const ChatModel = getChatModelClass(provider);
  const client = new ChatModel({
    ...options.llmConfig,
    ...(options.configOptions && { configuration: options.configOptions }),
    maxRetries: 0,
  } as never);
  /** Streams, as a chat turn does; the fake provider answers 400 to the first request. */
  const consume = async () => {
    for await (const _chunk of await client.stream([new HumanMessage('Hallo')])) {
      /* nothing arrives */
    }
  };
  await expect(consume()).rejects.toThrow();
  expect(captured).toHaveLength(1);
  return { provider, request: captured[0] };
}

describe('platform models per API (owner decision)', () => {
  const appConfig = appConfigOf(foundry);

  it('serves Chat Completions at the provider URL with a bearer key and without `user`', async () => {
    const { provider, request } = await send(appConfig, 'mistral-medium-3-5', {
      temperature: 0.3,
    });

    expect(provider).toBe(Providers.OPENAI);
    expect(request.url).toBe(`${SERVICES}/openai/v1/chat/completions`);
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.body).toMatchObject({ model: 'mistral-medium-3-5', temperature: 0.3 });
    expect(request.body).not.toHaveProperty('user');
  });

  it("serves a model's own base URL instead of the provider's", async () => {
    const { request } = await send(appConfig, 'Mistral-Large-3');

    expect(request.url).toBe(
      'https://anno-systems-westeurope.openai.azure.com/openai/v1/chat/completions',
    );
    expect(request.body).toMatchObject({ model: 'Mistral-Large-3' });
  });

  it('serves the Responses API, without the sampling controls reasoning models reject', async () => {
    const { provider, request } = await send(appConfig, 'gpt-6.1-terra', {
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 500,
    });

    expect(provider).toBe(Providers.OPENAI);
    expect(request.url).toBe(`${SERVICES}/openai/v1/responses`);
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.body).toMatchObject({ model: 'gpt-6.1-terra', max_output_tokens: 500 });
    expect(request.body).not.toHaveProperty('temperature');
    expect(request.body).not.toHaveProperty('top_p');
    expect(request.body).not.toHaveProperty('user');
  });

  it('serves the Anthropic Messages API through the native client with `x-api-key`', async () => {
    const { provider, request } = await send(appConfig, 'claude-sonnet-5-5');

    expect(provider).toBe(Providers.ANTHROPIC);
    expect(request.url).toBe(`${SERVICES}/anthropic/v1/messages`);
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['anthropic-version']).toBeDefined();
    expect(request.body).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(request.body).not.toHaveProperty('metadata');
    expect(request.body).not.toHaveProperty('user');
  });

  it('keeps one endpoint, so the selector shows one provider and queues stay per model', () => {
    const [endpoint] = appConfig.endpoints?.custom ?? [];

    expect(appConfig.endpoints?.custom).toHaveLength(1);
    expect(endpoint).toMatchObject({
      name: 'azure-foundry',
      modelDisplayLabel: 'Azure AI Foundry',
      models: {
        default: ['mistral-medium-3-5', 'Mistral-Large-3', 'gpt-6.1-terra', 'claude-sonnet-5-5'],
      },
      modelLimits: { 'mistral-medium-3-5': { tokensPerMinute: 20000 } },
    });
    expect(endpoint).not.toHaveProperty('provider');
    expect(resolveModelLimits(appConfig, 'azure-foundry', 'mistral-medium-3-5')).toEqual({
      tokensPerMinute: 20000,
    });
    expect(resolveModelLimits(appConfig, 'azure-foundry', 'claude-sonnet-5-5')).toBeUndefined();
    expect(queueKey('azure-foundry', 'mistral-medium-3-5')).not.toBe(
      queueKey('azure-foundry', 'Mistral-Large-3'),
    );
  });

  it('serves no endpoint for a provider without a key', () => {
    const { apiKey: _key, ...keyless } = foundry;
    expect(appConfigOf(keyless).endpoints?.custom).toEqual([]);
  });

  it('serves an old document (no API, no model URL, its own `dropParams`) unchanged', async () => {
    const legacy: PlatformProvider = {
      ...foundry,
      models: [{ id: 'mistral-medium-3-5' }],
      dropParams: ['user', 'stop'],
    };
    const { provider, request } = await send(appConfigOf(legacy), 'mistral-medium-3-5', {
      stop: ['END'],
    });

    expect(provider).toBe(Providers.OPENAI);
    expect(request.url).toBe(`${SERVICES}/openai/v1/chat/completions`);
    expect(request.body).not.toHaveProperty('stop');
    expect(request.body).not.toHaveProperty('user');
  });
});
