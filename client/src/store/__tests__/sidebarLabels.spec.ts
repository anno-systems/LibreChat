import { createStore } from 'jotai';
import { SettingsTabValues } from 'librechat-data-provider';
import { registry } from '~/components/Nav/Settings/registry';
import { compactSidebarAtom } from '../sidebarLabels';

describe('compactSidebarAtom (fork: sidebar labels)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the wide, labelled sidebar', () => {
    expect(createStore().get(compactSidebarAtom)).toBe(false);
  });

  it('persists the switch back to the compact sidebar for the next load', () => {
    const store = createStore();
    store.set(compactSidebarAtom, true);

    expect(store.get(compactSidebarAtom)).toBe(true);
    expect(localStorage.getItem('compactSidebar')).toBe('true');
  });

  it('is offered in Settings → General → Layout', () => {
    const entry = registry.find((item) => item.id === 'compactSidebar');

    expect(entry).toMatchObject({
      tab: SettingsTabValues.GENERAL,
      section: 'layout',
      labelKey: 'com_nav_compact_sidebar',
    });
    expect(registry.find((item) => item.id === 'showLia')).toBeUndefined();
  });
});
