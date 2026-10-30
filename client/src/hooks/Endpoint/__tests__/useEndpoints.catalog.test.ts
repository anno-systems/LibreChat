import { renderHook } from '@testing-library/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { useEndpoints } from '../useEndpoints';

const endpointNames = ['azure-anno-systems-westeurope', 'Ollama', 'openAI', 'anthropic', 'bedrock'];
const models = {
  'azure-anno-systems-westeurope': ['gpt-6.1-terra', 'claude-sonnet-5-5'],
  Ollama: ['llama3'],
  openAI: ['gpt-4o', 'o4-mini'],
  anthropic: ['claude-sonnet-4-5'],
  bedrock: ['anthropic.claude-3-haiku'],
};

jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: models }),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: endpointNames }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: { 0?: string }) =>
    key === 'com_ui_model_hosting_direct' ? `${options?.[0]} direct` : key,
  useHasAccess: () => true,
  useShowMarketplace: () => false,
}));

const endpointsConfig = {
  'azure-anno-systems-westeurope': {
    order: 0,
    type: 'custom',
    modelDisplayLabel: 'Azure',
    modelLabels: { 'gpt-6.1-terra': 'GPT-6.1 Terra', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' },
    modelVendors: { 'gpt-6.1-terra': 'openai', 'claude-sonnet-5-5': 'anthropic' },
    hosting: { label: 'Azure', location: { type: 'global' } },
    modelLocations: { 'claude-sonnet-5-5': { type: 'country', code: 'SE' } },
  },
  Ollama: { order: 1, type: 'custom', modelDisplayLabel: 'Ollama' },
  openAI: { order: 2, userProvide: false },
  anthropic: { order: 3, userProvide: true },
  bedrock: { order: 4, userProvide: false },
} as unknown as TEndpointsConfig;

describe('useEndpoints with catalog endpoints (fork)', () => {
  it("names a catalog endpoint by its provider's label and carries vendors and hosting", () => {
    const { result } = renderHook(() =>
      useEndpoints({
        endpointsConfig,
        startupConfig: { interface: { modelSelect: true } } as never,
      }),
    );
    const [catalog, yaml, openAI, anthropic, bedrock] = result.current.mappedEndpoints;

    expect(catalog).toMatchObject({
      value: 'azure-anno-systems-westeurope',
      label: 'Azure',
      modelVendors: { 'gpt-6.1-terra': 'openai', 'claude-sonnet-5-5': 'anthropic' },
      hosting: { label: 'Azure', location: { type: 'global' } },
      modelLocations: { 'claude-sonnet-5-5': { type: 'country', code: 'SE' } },
    });
    /** Endpoints without catalog info keep upstream's name and no vendor data. */
    expect(yaml.label).toBe('Ollama');
    expect(yaml).not.toHaveProperty('modelVendors');
    expect(yaml).not.toHaveProperty('hosting');
    /** A built-in endpoint of one vendor joins that vendor, hosted "direct"; keyed ones stay. */
    expect(openAI).toMatchObject({
      label: 'OpenAI',
      modelVendors: { 'gpt-4o': 'openai', 'o4-mini': 'openai' },
      hosting: { label: 'OpenAI direct' },
    });
    expect(anthropic).not.toHaveProperty('modelVendors');
    expect(bedrock).not.toHaveProperty('modelVendors');
  });
});
