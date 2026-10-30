import type { AppConfig } from '@librechat/data-schemas';
import { createModelLabelLookup } from './labels';

const config = {
  modelSpecs: {
    list: [{ name: 'spec', label: 'Spec Large', preset: { endpoint: 'Mistral', model: 'large' } }],
  },
  endpoints: { custom: [{ name: 'Mistral', modelLabels: { small: 'Mistral Small' } }] },
} as unknown as AppConfig;

describe('createModelLabelLookup', () => {
  const findPlatformProviders = jest.fn(async (names: string[]) =>
    names.includes('Catalog')
      ? [{ models: [{ id: 'medium', label: 'Catalog Medium' }, { id: 'bare' }] }]
      : [],
  );
  const labelOf = createModelLabelLookup({ getConfig: async () => config, findPlatformProviders });

  it('takes a model spec label, then the endpoint model label, then the catalog label', async () => {
    expect(await labelOf({ endpoint: 'Mistral', model: 'large' })).toBe('Spec Large');
    expect(await labelOf({ endpoint: 'Mistral', model: 'small' })).toBe('Mistral Small');
    expect(await labelOf({ endpoint: 'Catalog', model: 'medium' })).toBe('Catalog Medium');
    expect(await labelOf({ endpoint: 'Catalog', model: 'bare' })).toBeUndefined();
    expect(await labelOf({ endpoint: 'Other', model: 'x' })).toBeUndefined();
  });

  it('works without a catalog', async () => {
    const lookup = createModelLabelLookup({ getConfig: async () => config });
    expect(await lookup({ endpoint: 'Catalog', model: 'medium' })).toBeUndefined();
  });
});
