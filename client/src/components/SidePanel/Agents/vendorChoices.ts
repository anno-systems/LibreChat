import { useCallback, useMemo } from 'react';
import { alternateName, resolveModelCatalogKey } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { Endpoint, Option, OptionWithIcon } from '~/common';
import {
  groupKeyOf,
  selectorItems,
  vendorFieldsOf,
  isVendorGrouped,
} from '~/components/Chat/Menus/Endpoints/vendors';
import { useHostingText } from '~/components/Chat/Menus/Endpoints/hosting';
import { useLocalize } from '~/hooks';

/** A provider and model the agent form stores. */
export interface AgentModelChoice {
  provider: string;
  model: string;
}

/** A model option of a vendor group names its endpoint too; endpoint names are URI-encoded. */
function entryValue(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}:${model}`;
}

function parseEntryValue(value: string): AgentModelChoice | null {
  const at = value.indexOf(':');
  if (at < 0) {
    return null;
  }
  return { provider: decodeURIComponent(value.slice(0, at)), model: value.slice(at + 1) };
}

/**
 * Fork: the agent editor's provider and model pickers with the model selector's vendor groups.
 * The first picker lists vendor groups ("Mistral", "OpenAI", …) where the vendor-grouped
 * endpoints stood and every other provider as before; for a group the second lists its models
 * across endpoints, each with its hosting line. The form still stores the real provider and
 * model.
 */
export default function useAgentModelChoices({
  providers,
  modelsData,
  endpointsConfig,
  provider,
  model,
}: {
  providers: Option[];
  modelsData: Record<string, string[] | undefined>;
  endpointsConfig: TEndpointsConfig | undefined;
  provider: string;
  model: string;
}) {
  const localize = useLocalize();
  const hostingText = useHostingText();
  const directLabel = useCallback(
    (vendorName: string) => localize('com_ui_model_hosting_direct', { 0: vendorName }),
    [localize],
  );

  const endpoints = useMemo<Endpoint[]>(
    () =>
      providers.map((option) => {
        const value = typeof option === 'string' ? option : String(option.value ?? '');
        const label = typeof option === 'string' ? option : (option.label ?? value);
        const models = modelsData[resolveModelCatalogKey(value, modelsData)] ?? [];
        const config = endpointsConfig?.[value];
        return {
          value,
          label: alternateName[label] ?? label,
          hasModels: models.length > 0,
          icon: null,
          models: models.map((name) => ({ name })),
          ...(config?.modelLabels && { modelNames: config.modelLabels }),
          ...vendorFieldsOf(value, config, models, directLabel),
        };
      }),
    [directLabel, endpointsConfig, modelsData, providers],
  );

  const items = useMemo(() => selectorItems(endpoints), [endpoints]);

  const providerItems = useMemo<OptionWithIcon[]>(
    () =>
      items.map((item) =>
        item.kind === 'vendor'
          ? { label: item.label, value: item.key }
          : { label: item.endpoint.label, value: item.endpoint.value },
      ),
    [items],
  );

  const current = endpoints.find((endpoint) => endpoint.value === provider);
  const group = useMemo(() => {
    if (!current || !isVendorGrouped(current)) {
      return null;
    }
    const groups = items.flatMap((item) => (item.kind === 'vendor' ? [item] : []));
    const key = groupKeyOf(current, model);
    return (
      groups.find((candidate) => candidate.key === key) ??
      groups.find((candidate) =>
        candidate.entries.some((entry) => entry.endpoint.value === provider),
      ) ??
      null
    );
  }, [current, items, model, provider]);

  const providerKey = group?.key ?? provider;
  const providerDisplay =
    providerItems.find((item) => item.value === providerKey)?.label ?? providerKey;

  const modelItems = useMemo<OptionWithIcon[]>(() => {
    if (group) {
      return group.entries.map(({ endpoint, model: id }) => ({
        label: endpoint.modelNames?.[id] ?? id,
        value: entryValue(endpoint.value, id),
        description: hostingText(
          endpoint.hosting?.label ?? endpoint.label,
          endpoint.modelLocations?.[id] ?? endpoint.hosting?.location,
        ),
      }));
    }
    /** Read by the provider itself, which need not be among the offered providers. */
    const models = provider ? (modelsData[resolveModelCatalogKey(provider, modelsData)] ?? []) : [];
    return models.map((name) => ({ label: name, value: name }));
  }, [group, hostingText, modelsData, provider]);

  const modelKey = group && model ? entryValue(provider, model) : model;
  const modelDisplay = group ? (current?.modelNames?.[model] ?? model) : model;

  /** What choosing an entry of the first picker selects: a group's current or first model. */
  const chooseProvider = useCallback(
    (key: string): AgentModelChoice | null => {
      const chosen = items.find((item) => item.kind === 'vendor' && item.key === key);
      if (!chosen || chosen.kind !== 'vendor') {
        return null;
      }
      const kept = chosen.entries.find(
        (entry) => entry.endpoint.value === provider && entry.model === model,
      );
      const entry = kept ?? chosen.entries[0];
      return { provider: entry.endpoint.value, model: entry.model };
    },
    [items, model, provider],
  );

  /** What a model option selects; null for a plain model id of the current provider. */
  const chooseModel = useCallback(
    (value: string): AgentModelChoice | null => (group ? parseEntryValue(value) : null),
    [group],
  );

  return {
    providerItems,
    providerKey,
    providerDisplay,
    modelItems,
    modelKey,
    modelDisplay,
    chooseProvider,
    chooseModel,
  };
}
