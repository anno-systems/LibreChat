import type { AppConfig, ModelRedirect } from '@librechat/data-schemas';
import {
  agentEndpoint,
  endpointTypeFor,
  agentProvidersFor,
  resolveModelRedirect,
  createModelRedirector,
  withAgentRedirect,
} from './redirect';

let n = 0;
function redirect(
  scope: string,
  from: [string, string],
  to: [string, string],
  extra: Partial<ModelRedirect> = {},
): ModelRedirect {
  n += 1;
  return {
    redirectId: `mm_${n}`,
    scope,
    from: { endpoint: from[0], model: from[1] },
    to: { endpoint: to[0], model: to[1] },
    updatedAt: new Date(1_000_000 + n),
    ...extra,
  };
}

describe('resolveModelRedirect', () => {
  it('follows chains to the last successor', () => {
    const redirects = [
      redirect('platform', ['Mistral', 'a'], ['Mistral', 'b']),
      redirect('platform', ['Mistral', 'b'], ['Azure', 'c']),
    ];
    const result = resolveModelRedirect(redirects, 'acme', { endpoint: 'Mistral', model: 'a' });
    expect(result?.to).toEqual({ endpoint: 'Azure', model: 'c' });
    expect(result?.applied.map((r) => r.redirectId)).toEqual([
      redirects[0].redirectId,
      redirects[1].redirectId,
    ]);
    expect(resolveModelRedirect(redirects, 'acme', { endpoint: 'Azure', model: 'c' })).toBeNull();
  });

  it('stops before a cycle returns to a model already passed', () => {
    const redirects = [
      redirect('platform', ['M', 'a'], ['M', 'b']),
      redirect('platform', ['M', 'b'], ['M', 'c']),
      redirect('platform', ['M', 'c'], ['M', 'a']),
    ];
    expect(resolveModelRedirect(redirects, 'acme', { endpoint: 'M', model: 'a' })?.to).toEqual({
      endpoint: 'M',
      model: 'c',
    });
    const self = [redirect('platform', ['M', 'x'], ['M', 'x'])];
    expect(resolveModelRedirect(self, 'acme', { endpoint: 'M', model: 'x' })).toBeNull();
  });

  it('prefers the tenant redirect, then the operator one for listed tenants, then for all', () => {
    const redirects = [
      redirect('platform', ['M', 'a'], ['M', 'all']),
      redirect('platform', ['M', 'a'], ['M', 'listed'], { tenantIds: ['acme', 'globex'] }),
      redirect('acme', ['M', 'a'], ['M', 'own']),
    ];
    const to = (tenantId?: string) =>
      resolveModelRedirect(redirects, tenantId, { endpoint: 'M', model: 'a' })?.to.model;
    expect(to('acme')).toBe('own');
    expect(to('globex')).toBe('listed');
    expect(to('initech')).toBe('all');
    expect(to(undefined)).toBe('all');
  });

  it('never applies a tenant redirect to another tenant', () => {
    const redirects = [redirect('acme', ['M', 'a'], ['M', 'b'])];
    expect(resolveModelRedirect(redirects, 'globex', { endpoint: 'M', model: 'a' })).toBeNull();
  });

  it('mixes scopes along a chain, each step tenant first', () => {
    const redirects = [
      redirect('platform', ['M', 'a'], ['M', 'b']),
      redirect('acme', ['M', 'b'], ['M', 'mine']),
      redirect('platform', ['M', 'b'], ['M', 'c']),
    ];
    expect(resolveModelRedirect(redirects, 'acme', { endpoint: 'M', model: 'a' })?.to.model).toBe(
      'mine',
    );
    expect(resolveModelRedirect(redirects, 'globex', { endpoint: 'M', model: 'a' })?.to.model).toBe(
      'c',
    );
  });
});

describe('endpoint helpers', () => {
  it('maps agent providers to endpoints and back', () => {
    expect(agentEndpoint('vertexai')).toBe('google');
    expect(agentEndpoint('Ollama')).toBe('ollama');
    expect(agentEndpoint('Mistral')).toBe('Mistral');
    expect(agentProvidersFor('google')).toEqual(['google', 'vertexai']);
    expect(agentProvidersFor('Mistral')).toEqual(['Mistral']);
    expect(endpointTypeFor('openAI')).toBeUndefined();
    expect(endpointTypeFor('Mistral')).toBe('custom');
  });
});

describe('createModelRedirector', () => {
  const redirects = [
    redirect('platform', ['Mistral', 'old'], ['Azure', 'new']),
    redirect('platform', ['openAI', 'gpt-4'], ['openAI', 'gpt-5']),
  ];
  const redirector = createModelRedirector({ getModelRedirects: () => redirects });

  it('moves an agent, but not a platform agent copy', () => {
    const agent = { provider: 'Mistral', model: 'old' };
    expect(redirector.redirectAgent(agent, 'acme')).toBe(true);
    expect(agent).toEqual({ provider: 'Azure', model: 'new' });
    const copy = { provider: 'Mistral', model: 'old', platformAgentId: 'support' };
    expect(redirector.redirectAgent(copy, 'acme')).toBe(false);
    expect(copy.model).toBe('old');
  });

  it('moves a chat request body and its endpoint type, but not the agents endpoint', () => {
    const body: Record<string, string> = { endpoint: 'openAI', model: 'gpt-4' };
    expect(redirector.redirectRequestBody(body, 'acme')).toBe(true);
    expect(body).toEqual({ endpoint: 'openAI', model: 'gpt-5' });
    const custom: Record<string, string> = {
      endpoint: 'Mistral',
      endpointType: 'custom',
      model: 'old',
    };
    redirector.redirectRequestBody(custom, 'acme');
    expect(custom).toEqual({ endpoint: 'Azure', endpointType: 'custom', model: 'new' });
    const agents = { endpoint: 'agents', model: 'gpt-4' };
    expect(redirector.redirectRequestBody(agents, 'acme')).toBe(false);
  });

  it('moves model spec presets and keeps the config when nothing moves', () => {
    const appConfig = {
      modelSpecs: {
        list: [
          { name: 'a', label: 'A', preset: { endpoint: 'openAI', model: 'gpt-4' } },
          { name: 'b', label: 'B', preset: { endpoint: 'agents', agent_id: 'agent_1' } },
        ],
      },
    } as unknown as AppConfig;
    const moved = redirector.redirectModelSpecs(appConfig, 'acme');
    const list = moved.modelSpecs?.list ?? [];
    const original = appConfig.modelSpecs?.list ?? [];
    expect(moved).not.toBe(appConfig);
    expect(list[0]?.preset?.model).toBe('gpt-5');
    expect(list[1]).toBe(original[1]);
    expect(original[0]?.preset?.model).toBe('gpt-4');
    const untouched = { modelSpecs: { list: [list[0]] } } as AppConfig;
    expect(redirector.redirectModelSpecs(untouched, 'acme')).toBe(untouched);
  });

  it('validates the agent after moving it', async () => {
    type Params = { req: { user?: { tenantId?: string } }; agent: { model?: string | null } };
    const validate = jest.fn(async ({ agent }: Params) => agent.model);
    const wrapped = withAgentRedirect(validate, redirector);
    const agent = { provider: 'openAI', model: 'gpt-4' };
    await expect(wrapped({ req: { user: { tenantId: 'acme' } }, agent })).resolves.toBe('gpt-5');
  });
});
