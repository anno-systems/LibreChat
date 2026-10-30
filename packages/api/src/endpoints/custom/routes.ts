import {
  ProviderId,
  EModelEndpoint,
  openAIBaseSchema,
  anthropicBaseSchema,
} from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';

/**
 * Fork: a custom endpoint's per-model route (`modelRoutes`). One endpoint, as the selector shows
 * it, can reach its models through different base URLs and APIs: the route of the requested model
 * replaces the endpoint's `baseURL`, `provider` and `dropParams` and adds its `addParams` over the
 * endpoint's. Every place that builds a request for a model (`initializeCustom`, provider
 * resolution, summarization) resolves the endpoint with the model, so the route reaches the
 * OpenAI-compatible client, the Responses API and the native Anthropic client alike.
 */
export function withModelRoute<T extends Partial<TEndpoint>>(
  endpoint: T,
  model?: string | null,
): T {
  const route = model ? endpoint.modelRoutes?.[model] : undefined;
  if (!route) {
    return endpoint;
  }
  return {
    ...endpoint,
    ...(route.baseURL && { baseURL: route.baseURL }),
    ...(route.provider && { provider: route.provider }),
    ...(route.addParams && { addParams: { ...endpoint.addParams, ...route.addParams } }),
    ...(route.dropParams && { dropParams: [...route.dropParams] }),
  };
}

/**
 * Request fields of one API that another API does not take. They come from the conversation
 * schemas the client parses settings with (`openAIBaseSchema`, `anthropicBaseSchema`), plus raw
 * OpenAI request fields no schema lists. A conversation or agent saved while its model ran
 * through one API keeps those settings when it moves to a model of the same endpoint that runs
 * through another, so they are removed before the request is built.
 */
const OPENAI_RAW_FIELDS = [
  'frequencyPenalty',
  'presencePenalty',
  'logit_bias',
  'logitBias',
  'logprobs',
  'top_logprobs',
  'topLogprobs',
  'n',
  'seed',
  'response_format',
  'parallel_tool_calls',
];

/** Fields shared by both schemas or set by LibreChat itself, never foreign. */
const COMMON_FIELDS = new Set(['model', 'user', 'stream', 'web_search']);

const openAIFields = Object.keys(openAIBaseSchema.shape);
const anthropicFields = Object.keys(anthropicBaseSchema.shape);

function foreignTo(own: string[], other: string[]): ReadonlySet<string> {
  const ownSet = new Set(own);
  return new Set(other.filter((key) => !ownSet.has(key) && !COMMON_FIELDS.has(key)));
}

/** OpenAI-only fields, which the Anthropic Messages API rejects. */
const NOT_ANTHROPIC = new Set([...foreignTo(anthropicFields, openAIFields), ...OPENAI_RAW_FIELDS]);
/** Anthropic-only fields (`topK`, thinking settings, prompt caching), foreign to OpenAI's APIs. */
const NOT_OPENAI = foreignTo(openAIFields, anthropicFields);
/** OpenRouter's parameter set takes prompt caching too. */
const NOT_OPENROUTER = new Set(
  [...NOT_OPENAI].filter((key) => key !== 'promptCache' && key !== 'promptCacheTtl'),
);

/**
 * Fork: a routed endpoint's request options without the fields the model's API does not take.
 * Only endpoints with `modelRoutes` are filtered (one endpoint whose models speak different
 * APIs); others are left as upstream builds them.
 */
export function withoutForeignParams<T extends Record<string, unknown>>(
  endpoint: Pick<Partial<TEndpoint>, 'modelRoutes' | 'provider' | 'customParams'>,
  options: T,
): T {
  if (!endpoint.modelRoutes) {
    return options;
  }
  let foreign: ReadonlySet<string> = NOT_OPENAI;
  if (endpoint.provider === EModelEndpoint.anthropic) {
    foreign = NOT_ANTHROPIC;
  } else if (endpoint.customParams?.defaultParamsEndpoint === ProviderId.openrouter) {
    foreign = NOT_OPENROUTER;
  }
  return Object.fromEntries(Object.entries(options).filter(([key]) => !foreign.has(key))) as T;
}

/**
 * Fork: the parameter set (`defaultParamsEndpoint`) of each routed model whose set differs from
 * the endpoint's, for the client's parameter panel and settings parsing. Holds no URLs or keys.
 */
export function modelParamsEndpointsOf(
  endpoint: Partial<TEndpoint>,
  resolve: (routed: Partial<TEndpoint>) => string | undefined,
): Record<string, string> | undefined {
  if (!endpoint.modelRoutes) {
    return undefined;
  }
  const own = resolve(endpoint) ?? EModelEndpoint.custom;
  const entries = Object.keys(endpoint.modelRoutes).flatMap((model) => {
    const routed = resolve(withModelRoute(endpoint, model)) ?? EModelEndpoint.custom;
    return routed === own ? [] : [[model, routed]];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
