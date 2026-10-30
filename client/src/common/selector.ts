import React from 'react';
import { TStartupConfig } from 'librechat-data-provider';

export interface Endpoint {
  value: string;
  label: string;
  hasModels: boolean;
  models?: Array<{ name: string; isGlobal?: boolean }>;
  icon: React.ReactNode;
  agentNames?: Record<string, string>;
  assistantNames?: Record<string, string>;
  /** Fork: display names of a custom endpoint's models (`modelLabels`), by model id. */
  modelNames?: Record<string, string>;
  modelIcons?: Record<string, string | undefined>;
  showMarketplace?: boolean;
  searchAliases?: string[];
}

export interface SelectedValues {
  endpoint: string | null;
  model: string | null;
  modelSpec: string | null;
}

export interface ModelSelectorProps {
  startupConfig: TStartupConfig | undefined;
}
