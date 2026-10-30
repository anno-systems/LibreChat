import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TLocation } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** A country code as its flag emoji (regional indicator symbols). */
function flagOf(code: string): string {
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((char) => 0x1f1a5 + char.charCodeAt(0)),
  );
}

function regionName(code: string, language: string | undefined): string {
  try {
    return new Intl.DisplayNames([language || 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Fork: where a vendor-grouped model runs, as one line: the provider's label and the model's
 * location ("Azure · Global", "Mistral (Paris) · 🇫🇷 France", "Own · EU", "OpenAI direct"),
 * which customers ask about for data protection. Shared by the model selector and the agent
 * editor.
 */
export function useHostingText(): (label: string, location?: TLocation) => string {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const language = i18n?.language;
  return useCallback(
    (label: string, location?: TLocation) => {
      if (!location) {
        return label;
      }
      let place: string;
      if (location.type === 'global') {
        place = localize('com_ui_model_location_global');
      } else if (location.type === 'eu') {
        place = localize('com_ui_model_location_eu');
      } else {
        place = `${flagOf(location.code)} ${regionName(location.code, language)}`;
      }
      return `${label} · ${place}`;
    },
    [language, localize],
  );
}
