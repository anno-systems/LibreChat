import { z } from 'zod';
import { EModelEndpoint } from './schemas';
import { ProviderId } from './providers';

/**
 * The companies that make catalog models (fork-only). The model selector groups a catalog
 * endpoint's models by vendor instead of by the provider account they run through, so a model
 * served by an Azure AI Foundry account shows under "Mistral", "OpenAI" or "Anthropic". The
 * operator may set a model's vendor; without one it is detected from the model id.
 */
export const VENDOR_IDS = [
  'mistral',
  'openai',
  'anthropic',
  'google',
  'meta',
  'deepseek',
  'xai',
  'cohere',
  'qwen',
  'other',
] as const;

export type VendorId = (typeof VENDOR_IDS)[number];

export const vendorIdSchema: z.ZodEnum<{ [K in VendorId]: K }> = z.enum(VENDOR_IDS);

export interface VendorInfo {
  id: VendorId;
  /** Brand name, shown as the group's heading; not translated. */
  name: string;
  /**
   * The client's provider icon: a provider id, or a model id whose maker the icon registry
   * knows (Meta has no provider id). Absent for `other`, which shows its provider's icon.
   */
  icon?: { provider?: ProviderId; model?: string };
}

/** Every vendor in the selector's order; `other` is last. */
export const vendors: readonly VendorInfo[] = [
  { id: 'mistral', name: 'Mistral', icon: { provider: ProviderId.mistral } },
  { id: 'openai', name: 'OpenAI', icon: { provider: ProviderId.openai } },
  { id: 'anthropic', name: 'Anthropic', icon: { provider: ProviderId.anthropic } },
  { id: 'google', name: 'Google', icon: { provider: ProviderId.google } },
  { id: 'meta', name: 'Meta', icon: { model: 'llama' } },
  { id: 'deepseek', name: 'DeepSeek', icon: { provider: ProviderId.deepseek } },
  { id: 'xai', name: 'xAI', icon: { provider: ProviderId.xai } },
  { id: 'cohere', name: 'Cohere', icon: { provider: ProviderId.cohere } },
  { id: 'qwen', name: 'Qwen', icon: { provider: ProviderId.qwen } },
  { id: 'other', name: 'Other' },
];

const byId = new Map<VendorId, VendorInfo>(vendors.map((vendor) => [vendor.id, vendor]));

export function getVendor(id: VendorId): VendorInfo {
  return byId.get(id) ?? byId.get('other')!;
}

export function isVendorId(value: unknown): value is VendorId {
  return typeof value === 'string' && byId.has(value as VendorId);
}

/**
 * Built-in endpoints that call one vendor directly; their models join that vendor's group with
 * the hosting line "<vendor> direct". Other built-ins (Azure OpenAI, which also serves other
 * makers' models, Bedrock, assistants, agents) keep their own rows.
 */
export const builtinEndpointVendors: Readonly<Partial<Record<string, VendorId>>> = {
  [EModelEndpoint.openAI]: 'openai',
  [EModelEndpoint.anthropic]: 'anthropic',
  [EModelEndpoint.google]: 'google',
};

/** First match wins; tested on the lower-cased id without its `vendor/` prefix. */
const VENDOR_RULES: ReadonlyArray<readonly [RegExp, VendorId]> = [
  [
    /^(mistral|mixtral|codestral|devstral|magistral|pixtral|ministral|voxtral|mathstral)/,
    'mistral',
  ],
  [/^(gpt|chatgpt|o\d)/, 'openai'],
  [/^claude/, 'anthropic'],
  [/^(gemini|gemma)/, 'google'],
  [/^(llama|meta-llama)/, 'meta'],
  [/^deepseek/, 'deepseek'],
  [/^grok/, 'xai'],
  [/^command/, 'cohere'],
  [/^qwen/, 'qwen'],
];

/** The id without a `vendor/` prefix such as OpenRouter's `anthropic/claude-…`. */
function baseId(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** The vendor a model id names, case-insensitively and ignoring a `vendor/` prefix. */
export function detectVendor(modelId: string): VendorId {
  const id = baseId(modelId).toLowerCase();
  return VENDOR_RULES.find(([pattern]) => pattern.test(id))?.[1] ?? 'other';
}

/** A model's vendor: the one stored for it, else the one its id names. */
export function vendorOf(model: { id: string; vendor?: VendorId | null }): VendorId {
  return model.vendor ?? detectVendor(model.id);
}

/** Words with a fixed spelling, by their lower-case form. */
const KNOWN_WORDS: Readonly<Record<string, string>> = {
  gpt: 'GPT',
  chatgpt: 'ChatGPT',
  oss: 'OSS',
  claude: 'Claude',
  gemini: 'Gemini',
  gemma: 'Gemma',
  llama: 'Llama',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  qwen: 'Qwen',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  codestral: 'Codestral',
  devstral: 'Devstral',
  magistral: 'Magistral',
  pixtral: 'Pixtral',
  ministral: 'Ministral',
  command: 'Command',
};

const NUMBER = /^\d+$/;
/** A version part is short, so dates (`2024-08-06`) and snapshots (`2411`) never join. */
const VERSION_PART = /^\d{1,2}$/;
/** A snapshot date such as `20241022`, dropped when it ends the id. */
const SNAPSHOT_DATE = /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/**
 * Two short numbers in a row become one dotted version (`3-5` → `3.5`), wherever they stand,
 * unless a number on either side makes them part of a longer run.
 */
function joinVersions(tokens: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const [current, next, after] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    const before = result[result.length - 1];
    if (
      next != null &&
      VERSION_PART.test(current) &&
      VERSION_PART.test(next) &&
      (before == null || !NUMBER.test(before)) &&
      (after == null || !NUMBER.test(after) || SNAPSHOT_DATE.test(after))
    ) {
      result.push(`${current}.${next}`);
      i++;
      continue;
    }
    result.push(current);
  }
  return result;
}

function wordOf(token: string): string {
  const lower = token.toLowerCase();
  const known = KNOWN_WORDS[lower];
  if (known) return known;
  const family = /^([a-z]+)(\d[\w.]*)$/.exec(lower);
  if (family && KNOWN_WORDS[family[1]]) return `${KNOWN_WORDS[family[1]]}${family[2]}`;
  /** Sizes (`70b`, `8x7b`) and short codes (`r1`, `v3`, `a22b`) are written in capitals. */
  if (/^\d+(\.\d+)?(x\d+)?[bmk]$/.test(lower) || /^[a-z]\d+[a-z]?$/.test(lower)) {
    return token.toUpperCase();
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * A readable name for a model id without a label: `mistral-medium-3-5` → "Mistral Medium 3.5",
 * `gpt-6.1-terra` → "GPT-6.1 Terra", `claude-sonnet-5-5` → "Claude Sonnet 5.5". Dashes and
 * underscores become spaces, words take their vendor's spelling (GPT, Claude, Gemini, Llama),
 * a GPT version stays joined ("GPT-4o"), two short numbers in a row become one version ("3.5")
 * anywhere, a trailing snapshot date (`20241022`) is dropped while ISO dates (`2024-08-06`)
 * stay, and OpenAI's o-series stays lower case ("o4-mini"). Any `vendor/` prefix is dropped.
 */
export function suggestModelLabel(modelId: string): string {
  const id = baseId(modelId);
  if (/^o\d/i.test(id)) return id.toLowerCase();
  /** An ISO date (`2024-08-06`) stays one token. */
  const split = id.match(/\d{4}-\d{2}-\d{2}|[^-_\s]+/g) ?? [];
  if (split.length === 0) return id;
  /** A trailing snapshot date (`claude-3-5-sonnet-20241022`) is dropped. */
  const dated = split.length > 1 && SNAPSHOT_DATE.test(split[split.length - 1]);
  const tokens = joinVersions(dated ? split.slice(0, -1) : split);
  const words: string[] = [];
  for (const token of tokens) {
    const word = wordOf(token);
    const previous = words[words.length - 1];
    if ((previous === 'GPT' || previous === 'ChatGPT') && /^\d/.test(token)) {
      words[words.length - 1] = `${previous}-${word}`;
      continue;
    }
    words.push(word);
  }
  return words.join(' ');
}

/** A model's display name: its label, else one derived from its id. */
export function modelLabelOf(model: { id: string; label?: string | null }): string {
  return model.label || suggestModelLabel(model.id);
}
