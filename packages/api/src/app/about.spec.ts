import { resolveAboutInfo } from './about';

describe('resolveAboutInfo', () => {
  it('uses BUILD_VERSION when set', () => {
    expect(resolveAboutInfo({ buildDate: '2026-10-29T08:00:00Z' }, ' sha-1a2b3c4 ')).toEqual({
      version: 'sha-1a2b3c4',
    });
  });

  it('falls back to the UTC build date', () => {
    expect(resolveAboutInfo({ buildDate: '2026-10-29T23:30:00Z' }, undefined)).toEqual({
      version: '2026-10-29',
    });
  });

  it('leaves the payload out without a version or a valid build date', () => {
    expect(resolveAboutInfo({ buildDate: null }, undefined)).toBeUndefined();
    expect(resolveAboutInfo({ buildDate: 'not-a-date' }, '  ')).toBeUndefined();
  });

  it('never carries commit or branch', () => {
    const info = { buildDate: '2026-10-29T08:00:00Z', commit: 'abc', branch: 'main' };
    expect(Object.keys(resolveAboutInfo(info, undefined) ?? {})).toEqual(['version']);
  });
});
