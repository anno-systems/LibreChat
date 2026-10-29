import { createStorageAtom } from './jotai-utils';

/**
 * Whether the desktop sidebar is the compact, icon-only rail (fork: sidebar labels). Off by
 * default, so the rail shows a short label beside each icon; Settings → Layout switches it back.
 */
export const compactSidebarAtom = createStorageAtom<boolean>('compactSidebar', false);
