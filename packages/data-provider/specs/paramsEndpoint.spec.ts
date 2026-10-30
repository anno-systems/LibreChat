import { EModelEndpoint, getDefaultParamsEndpoint } from '../src';
import type { TEndpointsConfig } from '../src';

/** Fork: a model routed through another API than its endpoint takes that API's parameter set. */
describe('getDefaultParamsEndpoint', () => {
  const endpointsConfig = {
    foundry: {
      order: 0,
      type: EModelEndpoint.custom,
      modelParamsEndpoints: { claude: EModelEndpoint.anthropic, gpt: EModelEndpoint.custom },
    },
    claudes: {
      order: 1,
      type: EModelEndpoint.custom,
      customParams: { defaultParamsEndpoint: EModelEndpoint.anthropic },
      modelParamsEndpoints: { gpt: EModelEndpoint.custom },
    },
  } as TEndpointsConfig;

  it("takes the model's set over the endpoint's", () => {
    expect(getDefaultParamsEndpoint(endpointsConfig, 'foundry', 'claude')).toBe('anthropic');
    expect(getDefaultParamsEndpoint(endpointsConfig, 'foundry', 'mistral')).toBeUndefined();
    expect(getDefaultParamsEndpoint(endpointsConfig, 'claudes', 'gpt')).toBeUndefined();
    expect(getDefaultParamsEndpoint(endpointsConfig, 'claudes', 'claude')).toBe('anthropic');
  });

  it("keeps the endpoint's set without a model", () => {
    expect(getDefaultParamsEndpoint(endpointsConfig, 'foundry')).toBeUndefined();
    expect(getDefaultParamsEndpoint(endpointsConfig, 'claudes')).toBe('anthropic');
  });
});
