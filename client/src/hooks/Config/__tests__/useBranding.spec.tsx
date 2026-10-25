import { renderHook } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import useBranding from '../useBranding';

const TENANT_ICON = 'data:image/png;base64,iVBORw0KGgo=';

const config = (overrides: Partial<TStartupConfig> = {}) =>
  ({ appTitle: 'OfficeChat', ...overrides }) as TStartupConfig;

describe('useBranding', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" type="image/png" href="assets/favicon-32x32.png">';
    document.title = 'LibreChat';
    localStorage.clear();
  });

  const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;

  it("shows the tenant's favicon and name on any signed-in page", () => {
    renderHook(() =>
      useBranding(
        config({
          interface: { branding: { favicon: TENANT_ICON } } as TStartupConfig['interface'],
        }),
      ),
    );

    expect(icon()).toBe(TENANT_ICON);
    expect(document.title).toBe('OfficeChat');
    expect(localStorage.getItem('appTitle')).toBe('OfficeChat');
  });

  it('keeps the shell icon without a tenant favicon', () => {
    const shell = icon();
    renderHook(() => useBranding(config()));

    expect(icon()).toBe(shell);
  });

  it('waits for the startup config', () => {
    const shell = icon();
    renderHook(() => useBranding(undefined));

    expect(icon()).toBe(shell);
    expect(document.title).toBe('LibreChat');
  });
});
