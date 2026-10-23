import { LocalStorageKeys } from 'librechat-data-provider';
import type { PostProcessorModule } from 'i18next';

const UPSTREAM_NAME = 'LibreChat';

let productName = '';

/**
 * The deployment's product name in the interface's copy (fork-only): with an app title other than
 * LibreChat, every translation that names LibreChat names the app title instead, so a branded
 * deployment never shows the upstream name. Without one, translations stay as they are.
 */
export function setProductName(name: string | null | undefined) {
  const trimmed = name?.trim() ?? '';
  productName = trimmed === UPSTREAM_NAME ? '' : trimmed;
}

/** The title the app stored at its last start, so the first render already uses it. */
function storedAppTitle(): string | null {
  try {
    return typeof localStorage === 'undefined'
      ? null
      : localStorage.getItem(LocalStorageKeys.APP_TITLE);
  } catch {
    return null;
  }
}

setProductName(storedAppTitle());

export const productNameProcessor: PostProcessorModule = {
  type: 'postProcessor',
  name: 'productName',
  process(value: string) {
    if (!productName || typeof value !== 'string' || !value.includes(UPSTREAM_NAME)) {
      return value;
    }
    return value.replaceAll(UPSTREAM_NAME, productName);
  },
};
