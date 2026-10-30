import type { CatalogApi } from '@librechat/data-schemas';

/**
 * Request fields a platform model rejects, by API and model family (fork-only). The operator no
 * longer lists them per provider: every model of a platform provider gets these rules as its
 * custom endpoint route's `dropParams` (`catalog.ts`), unless the model sets its own `dropParams`
 * (an advanced override that replaces them) or the provider still carries the `dropParams` of a
 * document written before the rules (kept as the provider's, unchanged).
 *
 * The names are the ones the request builders delete: `packages/api/src/endpoints/openai/llm.ts`
 * (`deleteConfigParam`, camelCase client fields or raw request fields) for `chat` and `responses`,
 * and `packages/api/src/endpoints/anthropic/llm.ts` for `anthropic`.
 *
 * | API                       | Models                                   | Dropped                                             |
 * | ------------------------- | ---------------------------------------- | --------------------------------------------------- |
 * | `chat`, `responses`       | every model (covers Mistral's families)  | `user`                                              |
 * | `chat`, `responses`       | reasoning: `o1`…`o9`, `gpt-5*`, `gpt-6*`+ (not `*-chat*`) | `temperature`, `topP`, `frequencyPenalty`, `presencePenalty`, `logitBias`, `logprobs`, `n` |
 * | `anthropic`               | every model                              | `metadata`                                          |
 *
 * - `user`: LibreChat sends the user's id as `user`. Mistral models and other Azure AI Foundry
 *   models reject it, and none of the platform's providers needs it (it was the catalog's default
 *   before these rules), so every OpenAI-shaped request leaves it out.
 * - Reasoning models reject sampling controls. Upstream drops them only for `o1`, `o3` and
 *   undotted `gpt-5` on any endpoint, and for GPT-6 only on OpenAI's and Azure's own endpoints;
 *   a catalog endpoint is neither, so the rule covers the whole families here.
 * - The token limit field needs no rule: upstream's request builder already sends
 *   `max_completion_tokens` (Chat Completions) or `max_output_tokens` (Responses) for `gpt-5`
 *   and later, and the OpenAI client does the same for `o`-series models.
 * - `metadata`: the Anthropic client puts the user's id into `metadata.user_id`, the Messages
 *   API's counterpart of `user`; it is left out for the same reason. OpenAI-only fields never
 *   reach that client, which builds native Messages requests.
 */

/** Sent by LibreChat, rejected by Mistral and other Azure AI Foundry models, needed by none. */
const USER_FIELD = 'user';

/** Sampling controls reasoning models reject, as the OpenAI request builder names them. */
const REASONING_SAMPLING = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'logprobs',
  'n',
] as const;

/** The Messages API's carrier of the user's id (`metadata.user_id`). */
const ANTHROPIC_USER_FIELD = 'metadata';

/** `o1`, `o3-mini`, `gpt-5`, `gpt-5.1-codex`, `gpt-6.1-terra`; not `gpt-5-chat-latest`. */
const REASONING_MODEL = /^(?!.*-chat)(?:o\d(?:$|[-.])|gpt-(?:[5-9]|\d{2,})(?:$|[-.]))/i;

/** A model id without a deployment prefix such as `azure/` or `openai/`. */
function bareModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}

export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL.test(bareModel(model));
}

/** The request fields a model of a platform provider rejects, by the rules above. */
export function defaultDropParams(api: CatalogApi, model: string): string[] {
  if (api === 'anthropic') {
    return [ANTHROPIC_USER_FIELD];
  }
  const params: string[] = [USER_FIELD];
  if (isReasoningModel(model)) {
    params.push(...REASONING_SAMPLING);
  }
  return params;
}

/**
 * The fields a model's requests leave out: its own override, else the provider's legacy list,
 * else the rules.
 */
export function effectiveDropParams(
  api: CatalogApi,
  model: { id: string; dropParams?: string[] },
  providerDropParams?: string[],
): string[] {
  return [...(model.dropParams ?? providerDropParams ?? defaultDropParams(api, model.id))];
}
