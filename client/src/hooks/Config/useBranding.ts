import { useEffect } from 'react';
import { LocalStorageKeys } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import { setProductName } from '~/locales/productName';
import { setBrandFavicon } from '~/utils/favicon';
import { setDocumentTitle } from '~/utils';

/**
 * The deployment's or tenant's branding on every signed-in page (fork-only): its name in the tab
 * and in place of "LibreChat" in translations, and its favicon. Runs in the signed-in layout, so
 * a page opened directly (projects, skills, search, agents) is branded like the chat.
 */
export default function useBranding(startupConfig?: TStartupConfig) {
  useEffect(() => {
    if (!startupConfig) {
      return;
    }
    setBrandFavicon(startupConfig.interface?.branding?.favicon);
    const appTitle = startupConfig.appTitle ?? '';
    if (!appTitle) {
      return;
    }
    setDocumentTitle(appTitle, true);
    setProductName(appTitle);
    localStorage.setItem(LocalStorageKeys.APP_TITLE, appTitle);
  }, [startupConfig]);
}
