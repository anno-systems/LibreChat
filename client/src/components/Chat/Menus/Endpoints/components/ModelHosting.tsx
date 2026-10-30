import { useMemo } from 'react';
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
 * Fork: the second line of a catalog model's row, naming where it runs: the provider's label and
 * the model's location ("Azure · Global", "Mistral · 🇫🇷 France", "Own · EU"), which customers
 * ask about for data protection.
 */
export default function ModelHosting({ label, location }: { label: string; location?: TLocation }) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const language = i18n?.language;
  const place = useMemo(() => {
    if (!location) {
      return null;
    }
    if (location.type === 'global') {
      return localize('com_ui_model_location_global');
    }
    if (location.type === 'eu') {
      return localize('com_ui_model_location_eu');
    }
    return (
      <>
        <span aria-hidden="true">{flagOf(location.code)} </span>
        {regionName(location.code, language)}
      </>
    );
  }, [language, localize, location]);

  return (
    <span className="text-text-secondary block truncate text-xs" data-testid="model-hosting">
      {label}
      {place != null && (
        <>
          <span aria-hidden="true"> · </span>
          {place}
        </>
      )}
    </span>
  );
}
