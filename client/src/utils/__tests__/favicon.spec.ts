import { setBrandFavicon } from '../favicon';

const TENANT_ICON = 'data:image/png;base64,iVBORw0KGgo=';

describe('setBrandFavicon', () => {
  beforeEach(() => {
    document.head.innerHTML = `
      <link rel="icon" type="image/png" sizes="32x32" href="assets/favicon-32x32.png">
      <link rel="icon" type="image/png" sizes="16x16" href="assets/favicon-16x16.png">
      <link rel="apple-touch-icon" href="assets/apple-touch-icon-180x180.png">`;
  });

  const hrefs = () =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('link')).map((link) => link.href);

  it('points every icon and the badge source at the tenant icon', () => {
    setBrandFavicon(TENANT_ICON);
    expect(hrefs()).toEqual([TENANT_ICON, TENANT_ICON, TENANT_ICON]);
    for (const link of document.querySelectorAll<HTMLLinkElement>('link')) {
      expect(link.dataset.originalHref).toBe(TENANT_ICON);
      expect(link.hasAttribute('type')).toBe(false);
    }
  });

  it('restores the shell icons when the tenant has none', () => {
    const shell = hrefs();
    setBrandFavicon(TENANT_ICON);
    setBrandFavicon(undefined);
    expect(hrefs()).toEqual(shell);
  });

  it('leaves the icons alone without a tenant icon', () => {
    const shell = hrefs();
    setBrandFavicon(undefined);
    expect(hrefs()).toEqual(shell);
    expect(document.querySelector('link')?.getAttribute('type')).toBe('image/png');
  });
});
