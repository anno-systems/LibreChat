import { __resetLocaleForTests, changeLanguageSafely } from './i18n';
import GermanBackfill from './de/backfill.json';
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

  it('fills keys upstream German lacks, and upstream German wins where it has them', async () => {
    await changeLanguageSafely('de');

    expect(i18n.t('com_ui_schedules')).toBe('Geplante Chats');
    const upstreamKeys = Object.keys(German).filter((key) => key in GermanBackfill);
    for (const key of upstreamKeys) {
      expect((i18n.t as (k: string) => string)(key)).toBe((German as Record<string, string>)[key]);
    }
  });

  it('backfills only keys that English defines, with the same placeholders', () => {
    const english = English as Record<string, string>;
    const placeholders = (text: string) => (text.match(/\{\{[^}]+\}\}|<\/?\d+\/?>/g) ?? []).sort();
    for (const [key, text] of Object.entries(GermanBackfill as Record<string, string>)) {
      expect(english[key]).toBeDefined();
      expect([key, placeholders(text)]).toEqual([key, placeholders(english[key])]);
    }
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
