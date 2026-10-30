import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { filterItems, getDisplayValue } from '../../utils';
import { renderCustomGroups } from '../CustomGroup';
import { renderEndpoints } from '../EndpointItem';
import { SearchResults } from '../SearchResults';

const mockHandleSelectModel = jest.fn();
const mockToggleFavoriteModel = jest.fn();
let mockSelectedValues: SelectedValues = { endpoint: '', model: '', modelSpec: '' };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    ({ com_ui_model_location_global: 'Global', com_ui_model_location_eu: 'EU' })[key] ?? key,
  useFavorites: () => ({
    isFavoriteModel: () => false,
    toggleFavoriteModel: mockToggleFavoriteModel,
    isFavoriteAgent: () => false,
    toggleFavoriteAgent: jest.fn(),
    isFavoriteSpec: () => false,
    toggleFavoriteSpec: jest.fn(),
  }),
  useIsActiveItem: () => ({ ref: { current: null }, isActive: false }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    agentsMap: undefined,
    assistantsMap: undefined,
    modelSpecs: [],
    endpointsConfig: {},
    selectedValues: mockSelectedValues,
    endpointSearchValues: {},
    handleSelectModel: mockHandleSelectModel,
    handleSelectSpec: jest.fn(),
    handleOpenKeyDialog: jest.fn(),
    handleSelectEndpoint: jest.fn(),
    setEndpointSearchValue: jest.fn(),
    endpointRequiresUserKey: () => false,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/useActiveItem', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, isActive: false }),
}));

/** Submenus render their heading and rows inline, as a group the test can look into. */
jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenu: ({
      id,
      children,
      label,
    }: {
      id?: string;
      children?: React.ReactNode;
      label?: React.ReactNode;
    }) =>
      React.createElement(
        'section',
        { 'data-testid': id },
        React.createElement('header', null, label),
        children,
      ),
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', ...rest }, children);
    }),
    CustomMenuSeparator: () => React.createElement('hr'),
  };
});

/** The owner's account: one Azure AI Foundry provider serving three vendors' models. */
const azure: Endpoint = {
  value: 'azure-anno-systems-westeurope',
  label: 'Azure',
  hasModels: true,
  icon: null,
  models: [
    { name: 'mistral-medium-3-5' },
    { name: 'Mistral-Large-3' },
    { name: 'gpt-6.1-terra' },
    { name: 'claude-sonnet-5-5' },
  ],
  modelNames: {
    'mistral-medium-3-5': 'Mistral Medium 3.5',
    'Mistral-Large-3': 'Mistral Large 3',
    'gpt-6.1-terra': 'GPT-6.1 Terra',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  },
  modelVendors: {
    'mistral-medium-3-5': 'mistral',
    'Mistral-Large-3': 'mistral',
    'gpt-6.1-terra': 'openai',
    'claude-sonnet-5-5': 'anthropic',
  },
  hosting: { label: 'Azure', location: { type: 'global' } },
};

/** A second provider: its Mistral model joins the same group, its unknown one stays apart. */
const paris: Endpoint = {
  value: 'mistral-paris',
  label: 'Mistral (Paris)',
  hasModels: true,
  icon: null,
  models: [{ name: 'mistral-small-4' }, { name: 'house-model' }],
  modelNames: { 'mistral-small-4': 'Mistral Small 4', 'house-model': 'House Model' },
  modelVendors: { 'mistral-small-4': 'mistral', 'house-model': 'other' },
  hosting: { label: 'Mistral (Paris)', location: { type: 'country', code: 'FR' } },
};

const yaml: Endpoint = {
  value: 'Ollama',
  label: 'Ollama',
  hasModels: true,
  icon: null,
  models: [{ name: 'llama3' }],
};

/** The built-in OpenAI endpoint, as `useEndpoints` maps it. */
const openAI: Endpoint = {
  value: 'openAI',
  label: 'OpenAI',
  hasModels: true,
  icon: null,
  models: [{ name: 'gpt-4o' }],
  modelNames: { 'gpt-4o': 'GPT-4o' },
  modelVendors: { 'gpt-4o': 'openai' },
  hosting: { label: 'OpenAI direct' },
};

const groupNamed = (key: string) => screen.getByTestId(`vendor-${key}-menu`);
const rowNamed = (scope: HTMLElement, name: string) =>
  within(scope)
    .getAllByRole('menuitem')
    .find((row) => row.textContent?.includes(name))!;

describe('vendor groups in the model selector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
  });

  it("puts the owner's four models into three vendor groups, each with its hosting", () => {
    render(<>{renderEndpoints([yaml, azure])}</>);

    const groups = screen.getAllByTestId(/^vendor-/).map((group) => group.dataset.testid);
    expect(groups).toEqual([
      'vendor-vendor:mistral-menu',
      'vendor-vendor:openai-menu',
      'vendor-vendor:anthropic-menu',
    ]);
    expect(within(groupNamed('vendor:mistral')).getByRole('banner')).toHaveTextContent('Mistral');
    expect(
      within(groupNamed('vendor:mistral'))
        .getAllByRole('menuitem')
        .map((row) => row.textContent),
    ).toEqual(['Mistral Medium 3.5Azure · Global', 'Mistral Large 3Azure · Global']);
    expect(within(groupNamed('vendor:openai')).getByRole('menuitem')).toHaveTextContent(
      'GPT-6.1 TerraAzure · Global',
    );
    expect(within(groupNamed('vendor:anthropic')).getByRole('menuitem')).toHaveTextContent(
      'Claude Sonnet 5.5Azure · Global',
    );
    expect(screen.getAllByTestId('model-hosting')).toHaveLength(4);
    /** The endpoint without catalog info keeps its own row, and its internal name is shown nowhere. */
    expect(screen.getByTestId('endpoint-Ollama-menu')).toBeInTheDocument();
    expect(screen.queryByText(/azure-anno-systems-westeurope/)).not.toBeInTheDocument();
  });

  it('selects the real endpoint and model and names it by its label', () => {
    render(<>{renderEndpoints([azure])}</>);

    fireEvent.click(rowNamed(groupNamed('vendor:openai'), 'GPT-6.1 Terra'));

    expect(mockHandleSelectModel).toHaveBeenCalledWith(azure, 'gpt-6.1-terra');
    const selected = { endpoint: azure.value, model: 'gpt-6.1-terra', modelSpec: '' };
    expect(
      getDisplayValue({
        localize: ((key: string) => key) as never,
        mappedEndpoints: [azure],
        selectedValues: selected,
        modelSpecs: [],
      }),
    ).toBe('GPT-6.1 Terra');
  });

  it('pins a row under its own endpoint', () => {
    render(<>{renderEndpoints([azure, paris])}</>);

    const row = rowNamed(groupNamed('vendor:mistral'), 'Mistral Small 4');
    fireEvent.click(within(row).getByRole('button', { name: 'com_ui_pin' }));

    expect(mockToggleFavoriteModel).toHaveBeenCalledWith({
      model: 'mistral-small-4',
      endpoint: 'mistral-paris',
    });
  });

  it("merges vendors across providers and keeps a provider's unknown models under its label", () => {
    mockSelectedValues = { endpoint: 'mistral-paris', model: 'mistral-small-4', modelSpec: '' };
    render(<>{renderEndpoints([azure, paris])}</>);

    const mistral = groupNamed('vendor:mistral');
    expect(within(mistral).getAllByRole('menuitem')).toHaveLength(3);
    expect(rowNamed(mistral, 'Mistral Small 4')).toHaveTextContent('Mistral (Paris) · 🇫🇷 France');
    expect(within(mistral).getByRole('banner')).toHaveTextContent('com_a11y_selected');
    const other = groupNamed('other:mistral-paris');
    expect(within(other).getByRole('banner')).toHaveTextContent('Mistral (Paris)');
    expect(within(other).getByRole('menuitem')).toHaveTextContent('House Model');
  });
});

describe('built-in endpoints in vendor groups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('merges the built-in OpenAI endpoint into the one OpenAI group, hosted "direct"', () => {
    render(<>{renderEndpoints([openAI, yaml, azure])}</>);

    expect(screen.getAllByTestId(/^vendor-vendor:openai/)).toHaveLength(1);
    expect(screen.queryByTestId('endpoint-openAI-menu')).not.toBeInTheDocument();
    const rows = within(groupNamed('vendor:openai')).getAllByRole('menuitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'GPT-4oOpenAI direct',
      'GPT-6.1 TerraAzure · Global',
    ]);
    /** The groups stand where the first grouped endpoint stood, before Ollama. */
    expect(screen.getAllByTestId(/-menu$/).map((group) => group.dataset.testid)).toEqual([
      'vendor-vendor:mistral-menu',
      'vendor-vendor:openai-menu',
      'vendor-vendor:anthropic-menu',
      'endpoint-Ollama-menu',
    ]);

    fireEvent.click(rows[0]);
    expect(mockHandleSelectModel).toHaveBeenCalledWith(openAI, 'gpt-4o');
  });
});

describe('model spec groups', () => {
  it("head a group named after a vendor-grouped endpoint with the endpoint's label", () => {
    const spec = {
      name: 'house',
      label: 'House spec',
      group: 'azure-anno-systems-westeurope',
      preset: { endpoint: 'azure-anno-systems-westeurope', model: 'gpt-6.1-terra' },
    } as never;
    render(<>{renderCustomGroups([spec], [yaml], { [azure.value]: azure.label })}</>);

    expect(screen.getByText('Azure')).toBeInTheDocument();
    expect(screen.queryByText('azure-anno-systems-westeurope')).not.toBeInTheDocument();
  });
});

describe('vendor groups in search', () => {
  const search = (term: string) => {
    const results = filterItems([yaml, azure, paris], term, undefined, undefined);
    return render(
      <SearchResults
        results={results}
        localize={((key: string) => key) as never}
        searchValue={term}
      />,
    );
  };
  const rows = () => screen.queryAllByRole('menuitem').map((row) => row.textContent);

  it('finds models by vendor name, grouped by vendor', () => {
    search('anthropic');
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(rows()).toEqual(['Claude Sonnet 5.5Azure · Global']);
  });

  it('finds every model of a provider by its hosting label', () => {
    search('azure');
    expect(rows()).toHaveLength(4);
    expect(screen.getByText('Mistral')).toBeInTheDocument();
    expect(screen.queryByText('Mistral (Paris)')).not.toBeInTheDocument();
  });

  it('finds models by label', () => {
    search('medium 3.5');
    expect(rows()).toEqual(['Mistral Medium 3.5Azure · Global']);
  });

  it('finds a model by its id and keeps the selected endpoint on click', () => {
    search('terra');
    expect(rows()).toEqual(['GPT-6.1 TerraAzure · Global']);
    fireEvent.click(screen.getByRole('menuitem'));
    expect(mockHandleSelectModel).toHaveBeenCalledWith(azure, 'gpt-6.1-terra');
  });
});
