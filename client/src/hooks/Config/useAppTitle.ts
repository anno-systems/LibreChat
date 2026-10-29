import { useGetStartupConfig } from '~/data-provider';
import { toAppTitle } from '~/utils/documentTitle';

/**
 * The deployment's or tenant's product name (fork-only), for tab titles and other copy that
 * would otherwise name LibreChat. Falls back to upstream's name until the config loads.
 */
export default function useAppTitle(): string {
  const { data: startupConfig } = useGetStartupConfig();
  return toAppTitle(startupConfig?.appTitle);
}
