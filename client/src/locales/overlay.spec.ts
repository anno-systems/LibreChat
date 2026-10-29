import { __resetLocaleForTests, changeLanguageSafely } from './i18n';
import English from './en/translation.json';
import German from './de/translation.json';
import GermanFork from './de/fork.json';
import { withOverlay } from './overlay';
import i18n from './i18n';

describe('German fork overlay', () => {
  afterEach(async () => {
    await changeLanguageSafely('en');
    __resetLocaleForTests('de');
  });

  it('loads the fork strings with upstream German', async () => {
    await changeLanguageSafely('de');

    expect(i18n.t('com_ui_manage_agents')).toBe('Agenten verwalten');
    expect(i18n.t('com_nav_compact_sidebar')).toBe('Kompakte Seitenleiste (nur Symbole)');
    expect(i18n.t('com_ui_admin_settings')).toBe(German.com_ui_admin_settings);
  });

  it('translates only keys that English defines', () => {
    const englishKeys = new Set(Object.keys(English));
    expect(Object.keys(GermanFork).filter((key) => !englishKeys.has(key))).toEqual([]);
  });

  it('lets the overlay win over the base file', async () => {
    const merged = await withOverlay(
      Promise.resolve({ default: { a: 'base', b: 'base' } }),
      Promise.resolve({ default: { b: 'fork' } }),
    );
    expect(merged.default).toEqual({ a: 'base', b: 'fork' });
  });
});
