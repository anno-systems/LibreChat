import {
  vendors,
  vendorOf,
  getVendor,
  VENDOR_IDS,
  detectVendor,
  modelLabelOf,
  vendorIdSchema,
  suggestModelLabel,
  builtinEndpointVendors,
} from '../src/vendors';

describe('detectVendor', () => {
  it.each([
    ['mistral-medium-3-5', 'mistral'],
    ['Mistral-Large-3', 'mistral'],
    ['codestral-latest', 'mistral'],
    ['magistral-medium-2509', 'mistral'],
    ['pixtral-large-latest', 'mistral'],
    ['ministral-8b-latest', 'mistral'],
    ['gpt-6.1-terra', 'openai'],
    ['GPT-4o', 'openai'],
    ['o4-mini', 'openai'],
    ['o3', 'openai'],
    ['chatgpt-4o-latest', 'openai'],
    ['claude-sonnet-5-5', 'anthropic'],
    ['Claude-Opus-4-1', 'anthropic'],
    ['gemini-2.5-pro', 'google'],
    ['gemma-3-27b-it', 'google'],
    ['llama-3.3-70b-instruct', 'meta'],
    ['Meta-Llama-3.1-405B-Instruct', 'meta'],
    ['deepseek-r1', 'deepseek'],
    ['DeepSeek-V3.2', 'deepseek'],
    ['grok-4', 'xai'],
    ['command-r-plus', 'cohere'],
    ['qwen3-235b-a22b', 'qwen'],
    ['anthropic/claude-sonnet-4.5', 'anthropic'],
    ['openai/gpt-5', 'openai'],
    ['meta-llama/Llama-3.3-70B-Instruct', 'meta'],
    ['  Mistral-small  ', 'mistral'],
    ['phi-4', 'other'],
    ['omni-moderation-latest', 'other'],
    ['my-model', 'other'],
    ['', 'other'],
  ])('%s is %s', (id, vendor) => {
    expect(detectVendor(id)).toBe(vendor);
  });

  it('prefers a stored vendor over the detected one', () => {
    expect(vendorOf({ id: 'gpt-6.1-terra' })).toBe('openai');
    expect(vendorOf({ id: 'gpt-6.1-terra', vendor: 'other' })).toBe('other');
    expect(vendorOf({ id: 'house-model', vendor: 'mistral' })).toBe('mistral');
  });
});

describe('built-in endpoints', () => {
  it('maps the direct endpoints to their vendor and nothing else', () => {
    expect(builtinEndpointVendors).toEqual({
      openAI: 'openai',
      anthropic: 'anthropic',
      google: 'google',
    });
  });
});

describe('vendor registry', () => {
  it('lists every vendor once, `other` last, each named', () => {
    expect(vendors.map((vendor) => vendor.id)).toEqual([...VENDOR_IDS]);
    expect(vendors[vendors.length - 1].id).toBe('other');
    expect(getVendor('xai').name).toBe('xAI');
    expect(getVendor('meta').icon).toEqual({ model: 'llama' });
  });

  it('accepts only known vendor ids', () => {
    expect(vendorIdSchema.safeParse('anthropic').success).toBe(true);
    expect(vendorIdSchema.safeParse('Anthropic').success).toBe(false);
    expect(vendorIdSchema.safeParse('acme').success).toBe(false);
  });
});

describe('suggestModelLabel', () => {
  it.each([
    ['mistral-medium-3-5', 'Mistral Medium 3.5'],
    ['gpt-6.1-terra', 'GPT-6.1 Terra'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['Mistral-Large-3', 'Mistral Large 3'],
    ['o4-mini', 'o4-mini'],
    ['O3-Pro', 'o3-pro'],
    ['openai/o4-mini', 'o4-mini'],
    ['gpt-4o', 'GPT-4o'],
    ['gpt-4o-mini', 'GPT-4o Mini'],
    ['gpt-5-5', 'GPT-5.5'],
    ['gpt-oss-120b', 'GPT OSS 120B'],
    ['chatgpt-4o-latest', 'ChatGPT-4o Latest'],
    ['gpt-4o-2024-08-06', 'GPT-4o 2024-08-06'],
    ['claude-opus-4-1', 'Claude Opus 4.1'],
    ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
    ['claude-3-5-haiku-latest', 'Claude 3.5 Haiku Latest'],
    ['claude-opus-4-1-20250805', 'Claude Opus 4.1'],
    ['claude-3-haiku-20240307', 'Claude 3 Haiku'],
    ['mistral-small-3-1-24b-instruct', 'Mistral Small 3.1 24B Instruct'],
    ['qwen-2-5-72b', 'Qwen 2.5 72B'],
    ['gemini-2-0-flash-001', 'Gemini 2.0 Flash 001'],
    ['model-1-2-3', 'Model 1 2 3'],
    ['release-20241022', 'Release'],
    ['build-20241399', 'Build 20241399'],
    ['20241022', '20241022'],
    ['anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct'],
    ['meta-llama/Llama-3.3-70B-Instruct', 'Llama 3.3 70B Instruct'],
    ['deepseek-r1', 'DeepSeek R1'],
    ['qwen3-235b-a22b', 'Qwen3 235B A22B'],
    ['command-r-plus', 'Command R Plus'],
    ['codestral_latest', 'Codestral Latest'],
    ['mistral-large-2411', 'Mistral Large 2411'],
    ['model-3', 'Model 3'],
  ])('%s → %s', (id, label) => {
    expect(suggestModelLabel(id)).toBe(label);
  });

  it('keeps an explicit label', () => {
    expect(modelLabelOf({ id: 'mistral-medium-3-5', label: 'Mistral Medium' })).toBe(
      'Mistral Medium',
    );
    expect(modelLabelOf({ id: 'mistral-medium-3-5' })).toBe('Mistral Medium 3.5');
  });
});
