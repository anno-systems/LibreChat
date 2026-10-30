import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, filterModels, getDisplayValue } from '../utils';

const agentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  icon: null,
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('model selector utilities', () => {
  it('matches endpoint search aliases', () => {
    const results = filterItems([agentsEndpoint], 'marketplace', undefined, undefined);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('matches localized Marketplace labels', () => {
    const localize = ((key: string) => {
      if (key === 'com_agents_marketplace') {
        return 'Tienda de Agentes';
      }
      if (key === 'com_ui_marketplace') {
        return 'Tienda';
      }
      return key;
    }) as ReturnType<typeof useLocalize>;

    const results = filterItems([agentsEndpoint], 'tienda', undefined, undefined, localize);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('does not match agents when there are no selectable agent options', () => {
    const results = filterItems([disabledAgentsEndpoint], 'my agents', undefined, undefined);
    expect(results).toEqual([]);
  });

  it('finds and shows a custom endpoint model by its display name', () => {
    const mistral: Endpoint = {
      value: 'mistral',
      label: 'Mistral',
      hasModels: true,
      icon: null,
      models: [{ name: 'mistral-large-2411' }, { name: 'mistral-small' }],
      modelNames: { 'mistral-large-2411': 'Mistral Large' },
    };

    expect(filterItems([mistral], 'large', undefined, undefined)).toEqual([mistral]);
    expect(filterItems([mistral], 'mistral l', undefined, undefined)).toEqual([mistral]);
    expect(
      filterModels(
        mistral,
        ['mistral-large-2411', 'mistral-small'],
        'mistral l',
        undefined,
        undefined,
      ),
    ).toEqual(['mistral-large-2411']);
    expect(
      getDisplayValue({
        localize: ((key: string) => key) as ReturnType<typeof useLocalize>,
        selectedValues: { endpoint: 'mistral', model: 'mistral-large-2411', modelSpec: '' },
        mappedEndpoints: [mistral],
        modelSpecs: [],
      }),
    ).toBe('Mistral Large');
  });
});
