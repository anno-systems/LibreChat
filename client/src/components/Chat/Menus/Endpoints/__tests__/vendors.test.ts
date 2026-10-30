import type { TConfig } from 'librechat-data-provider';
import { modelLabelFor, vendorFieldsOf } from '../vendors';

const direct = (name: string) => `${name} direct`;

describe('vendorFieldsOf (fork)', () => {
  it('names built-in models by a label the deployment set, else one derived from the id', () => {
    const fields = vendorFieldsOf(
      'openAI',
      { modelLabels: { 'gpt-4.1': 'House GPT' } } as unknown as TConfig,
      ['gpt-4o', 'gpt-4.1', 'o4-mini'],
      direct,
    );
    expect(fields).toEqual({
      modelVendors: { 'gpt-4o': 'openai', 'gpt-4.1': 'openai', 'o4-mini': 'openai' },
      modelNames: { 'gpt-4o': 'GPT-4o', 'gpt-4.1': 'House GPT', 'o4-mini': 'o4-mini' },
      hosting: { label: 'OpenAI direct' },
    });
  });

  it('leaves a built-in endpoint with a user key and other endpoints ungrouped', () => {
    expect(vendorFieldsOf('anthropic', { userProvide: true } as TConfig, ['x'], direct)).toBeNull();
    expect(vendorFieldsOf('bedrock', undefined, ['x'], direct)).toBeNull();
  });
});

describe('modelLabelFor (fork)', () => {
  it("shows a catalog label, a built-in's derived label, else the id", () => {
    const catalog = {
      modelLabels: { 'claude-sonnet-5-5': 'Claude Sonnet 5.5' },
      modelVendors: { 'claude-sonnet-5-5': 'anthropic' },
      hosting: { label: 'Azure' },
    } as unknown as TConfig;
    expect(modelLabelFor('azure', 'claude-sonnet-5-5', catalog)).toBe('Claude Sonnet 5.5');
    expect(modelLabelFor('anthropic', 'claude-sonnet-4-5', undefined)).toBe('Claude Sonnet 4.5');
    expect(modelLabelFor('Ollama', 'llama3', {} as TConfig)).toBe('llama3');
    expect(modelLabelFor('anthropic', 'claude-sonnet-4-5', { userProvide: true } as TConfig)).toBe(
      'claude-sonnet-4-5',
    );
  });
});
