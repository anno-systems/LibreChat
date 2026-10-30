import React from 'react';
import { TStartupConfig } from 'librechat-data-provider';
import type { TLocation, VendorId } from 'librechat-data-provider';

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
  /**
   * Fork: a catalog endpoint's model vendors (`modelVendors`), by model id. Present only on
   * catalog endpoints, whose models the selector groups by vendor.
   */
  modelVendors?: Record<string, VendorId>;
  /** Fork: a catalog endpoint's provider label and location, shown under each model. */
  hosting?: { label: string; location?: TLocation };
  /** Fork: models whose location differs from `hosting.location`, by model id. */
  modelLocations?: Record<string, TLocation>;
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
