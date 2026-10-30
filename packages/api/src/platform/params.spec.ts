import { defaultDropParams, effectiveDropParams, isReasoningModel } from './params';

const SAMPLING = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'logprobs',
  'n',
];

describe('defaultDropParams', () => {
  it('leaves out `user` for every OpenAI-shaped model, Mistral included', () => {
    for (const model of ['mistral-medium-3-5', 'Mistral-Large-3', 'codestral-2', 'gpt-4.1']) {
      expect(defaultDropParams('chat', model)).toEqual(['user']);
    }
    expect(defaultDropParams('responses', 'gpt-4o')).toEqual(['user']);
  });

  it('leaves out sampling controls for reasoning models on both OpenAI APIs', () => {
    for (const model of ['gpt-6.1-terra', 'gpt-5', 'gpt-5.1-codex', 'o3-mini', 'o1', 'azure/o4']) {
      expect(defaultDropParams('chat', model)).toEqual(['user', ...SAMPLING]);
      expect(defaultDropParams('responses', model)).toEqual(['user', ...SAMPLING]);
    }
  });

  it('keeps sampling controls for chat variants and other families', () => {
    for (const model of ['gpt-5-chat-latest', 'gpt-4o', 'omni-moderation', 'gpt-50x', 'llama-o3']) {
      expect(isReasoningModel(model)).toBe(false);
      expect(defaultDropParams('chat', model)).toEqual(['user']);
    }
  });

  it("leaves out only the Anthropic client's user carrier on the Messages API", () => {
    expect(defaultDropParams('anthropic', 'claude-sonnet-5-5')).toEqual(['metadata']);
  });
});

describe('effectiveDropParams', () => {
  it("takes the model's override, else the provider's legacy list, else the rules", () => {
    const model = { id: 'gpt-6.1-terra' };

    expect(effectiveDropParams('responses', { ...model, dropParams: ['stop'] }, ['user'])).toEqual([
      'stop',
    ]);
    expect(effectiveDropParams('responses', model, ['user', 'stop'])).toEqual(['user', 'stop']);
    expect(effectiveDropParams('responses', model)).toEqual(['user', ...SAMPLING]);
    expect(effectiveDropParams('chat', { id: 'x', dropParams: [] })).toEqual([]);
  });
});
