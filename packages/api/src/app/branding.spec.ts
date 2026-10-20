import { brandedStartupFields } from './branding';

describe('brandedStartupFields', () => {
  it('returns nothing without branding', () => {
    expect(brandedStartupFields(undefined, { signedIn: true })).toEqual({});
    expect(brandedStartupFields({ modelSelect: true }, { signedIn: true })).toEqual({});
  });

  it('replaces the title for everyone and the footer only for signed-in callers', () => {
    const interfaceConfig = { branding: { appTitle: 'Acme AI', footer: 'Acme' } };
    expect(brandedStartupFields(interfaceConfig, { signedIn: false })).toEqual({
      appTitle: 'Acme AI',
    });
    expect(brandedStartupFields(interfaceConfig, { signedIn: true })).toEqual({
      appTitle: 'Acme AI',
      customFooter: 'Acme',
    });
  });

  it('keeps an empty footer, which hides the default disclaimer', () => {
    expect(brandedStartupFields({ branding: { footer: '' } }, { signedIn: true })).toEqual({
      customFooter: '',
    });
  });
});
