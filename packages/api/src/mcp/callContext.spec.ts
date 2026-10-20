import { buildMCPCallMeta, MCP_CALL_CONTEXT_META_KEY } from './callContext';

const input = {
  model: 'mistral-small-latest',
  agentId: 'agent_abc',
  requestBody: { conversationId: 'convo-1', messageId: 'msg-1' },
};

describe('buildMCPCallMeta', () => {
  it('sends a saved agent without its index suffix', () => {
    expect(
      buildMCPCallMeta({ callContext: true }, { agentId: 'agent_abc____1' })?.[
        MCP_CALL_CONTEXT_META_KEY
      ],
    ).toEqual({ agentId: 'agent_abc' });
  });

  it('sends nothing unless the server opted in', () => {
    expect(buildMCPCallMeta(undefined, input)).toBeUndefined();
    expect(buildMCPCallMeta({}, input)).toBeUndefined();
    expect(buildMCPCallMeta({ callContext: false }, input)).toBeUndefined();
  });

  it('sends model, agent, conversation and message under its key', () => {
    expect(buildMCPCallMeta({ callContext: true }, input)).toEqual({
      [MCP_CALL_CONTEXT_META_KEY]: {
        model: 'mistral-small-latest',
        agentId: 'agent_abc',
        conversationId: 'convo-1',
        messageId: 'msg-1',
      },
    });
  });

  it('leaves out ephemeral agents, new conversations and empty values', () => {
    expect(
      buildMCPCallMeta(
        { callContext: true },
        {
          model: '',
          agentId: 'Mistral EU__mistral-small-latest___Mistral',
          requestBody: { conversationId: 'new', messageId: 'm' },
        },
      ),
    ).toEqual({ [MCP_CALL_CONTEXT_META_KEY]: { messageId: 'm' } });
  });

  it('sends no _meta when nothing is known', () => {
    expect(buildMCPCallMeta({ callContext: true }, { requestBody: null })).toBeUndefined();
  });
});
