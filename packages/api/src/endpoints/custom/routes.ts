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
