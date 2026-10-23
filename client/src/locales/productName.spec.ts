import { setProductName } from './productName';
import i18n from './i18n';

describe('product name in translations', () => {
  afterEach(() => setProductName(''));

  it('names the app title wherever a translation names LibreChat', async () => {
    await i18n.changeLanguage('en');
    setProductName('OfficeChat');

    expect(i18n.t('com_ui_tools_native_short')).toBe('Built into OfficeChat');
    expect(i18n.t('com_ui_logo', { 0: 'OfficeChat' })).not.toContain('LibreChat');
  });

  it('leaves translations as they are without an app title or with LibreChat itself', () => {
    setProductName('LibreChat');
    expect(i18n.t('com_ui_tools_native_short')).toBe('Built into LibreChat');
    setProductName('  ');
    expect(i18n.t('com_ui_tools_native_short')).toBe('Built into LibreChat');
  });
});
