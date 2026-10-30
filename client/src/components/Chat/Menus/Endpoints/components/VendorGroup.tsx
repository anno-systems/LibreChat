import { useCallback, useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { VisuallyHidden } from '@ariakit/react';
import type { VendorEntry, VendorGroup } from '../vendors';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { EndpointModelItem } from './EndpointModelItem';
import { useFavorites, useLocalize } from '~/hooks';
import { CustomMenu as Menu } from '../CustomMenu';
import { catalogModelMatches } from '../vendors';
import VendorIcon from './VendorIcon';

/** Fork: the group's mark: the vendor's, or the provider's for its models of no known vendor. */
export function VendorGroupIcon({ group }: { group: Pick<VendorGroup, 'vendor' | 'endpoint'> }) {
  if (group.vendor === 'other') {
    return group.endpoint?.icon ? <>{group.endpoint.icon}</> : null;
  }
  return <VendorIcon vendor={group.vendor} />;
}

/**
 * Fork: the rows of a vendor group, each with its real endpoint, so selecting and pinning a row
 * name that endpoint and model. `useFavorites` is called once for all rows.
 */
export function VendorModelRows({
  entries,
  precedingOptionCount,
  setSize,
}: {
  entries: VendorEntry[];
  /** Set only in search results, where the options of all groups share one listbox. */
  precedingOptionCount?: number;
  setSize?: number;
}) {
  const { isFavoriteModel, toggleFavoriteModel } = useFavorites();
  const toggles = useMemo(() => {
    const byEndpoint = new Map<string, (model: string) => void>();
    for (const { endpoint } of entries) {
      if (!byEndpoint.has(endpoint.value)) {
        byEndpoint.set(endpoint.value, (model: string) =>
          toggleFavoriteModel({ model, endpoint: endpoint.value }),
        );
      }
    }
    return byEndpoint;
  }, [entries, toggleFavoriteModel]);

  return (
    <>
      {entries.map(({ endpoint, model }, index) => (
        <EndpointModelItem
          key={`${endpoint.value}-${model}`}
          modelId={model}
          endpoint={endpoint}
          isFavorite={isFavoriteModel(model, endpoint.value)}
          onToggleFavorite={toggles.get(endpoint.value)!}
          posInSet={precedingOptionCount != null ? precedingOptionCount + index + 1 : undefined}
          setSize={setSize}
        />
      ))}
    </>
  );
}

/** Fork: one vendor's models across every catalog endpoint, as a submenu with its own search. */
export function VendorGroupItem({ group }: { group: VendorGroup }) {
  const localize = useLocalize();
  const { selectedValues, endpointSearchValues, setEndpointSearchValue } =
    useModelSelectorContext();
  const searchValue = endpointSearchValues[group.key] || '';
  const onSearch = useCallback(
    (value: string) => setEndpointSearchValue(group.key, value),
    [group.key, setEndpointSearchValue],
  );
  const entries = useMemo(
    () =>
      searchValue
        ? group.entries.filter(({ endpoint, model }) =>
            catalogModelMatches(endpoint, model, searchValue),
          )
        : group.entries,
    [group.entries, searchValue],
  );
  const isSelected =
    !selectedValues.modelSpec &&
    group.entries.some(
      ({ endpoint, model }) =>
        endpoint.value === selectedValues.endpoint && model === selectedValues.model,
    );

  return (
    <Menu
      id={`vendor-${group.key}-menu`}
      searchValue={searchValue}
      onSearch={onSearch}
      combobox={<input placeholder=" " />}
      comboboxLabel={localize('com_endpoint_search_endpoint_models', { 0: group.label })}
      label={
        <div className="group flex w-full min-w-0 items-center justify-between gap-1.5 py-1 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex shrink-0 items-center justify-center" aria-hidden="true">
              <VendorGroupIcon group={group} />
            </div>
            <span className="truncate text-start">{group.label}</span>
          </div>
          {isSelected && (
            <div className="flex shrink-0 items-center gap-1">
              <CheckCircle2 className="text-text-primary size-4 shrink-0" aria-hidden="true" />
              <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
            </div>
          )}
        </div>
      }
    >
      <VendorModelRows entries={entries} />
    </Menu>
  );
}
