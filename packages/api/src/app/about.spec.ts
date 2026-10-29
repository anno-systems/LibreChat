import { resolveAboutInfo } from './about';

describe('resolveAboutInfo', () => {
  it('uses BUILD_VERSION when set', () => {
    const info = { buildDate: '2026-10-29T08:00:00Z', commitShort: '1a2b3c4' };
    expect(resolveAboutInfo(info, ' v1.2.0 ')).toEqual({ version: 'v1.2.0' });
  });

  it('names the UTC build date and the image tag of the commit', () => {
    expect(
      resolveAboutInfo({ buildDate: '2026-10-29T23:30:00Z', commitShort: '1a2b3c4' }, undefined),
    ).toEqual({ version: '2026-10-29 (sha-1a2b3c4)' });
  });

  it('falls back to the UTC build date alone without a commit', () => {
    expect(resolveAboutInfo({ buildDate: '2026-10-29T23:30:00Z', commitShort: null }, '')).toEqual({
      version: '2026-10-29',
    });
  });

  it('leaves the payload out without a version or a valid build date', () => {
    expect(
      resolveAboutInfo({ buildDate: null, commitShort: '1a2b3c4' }, undefined),
    ).toBeUndefined();
    expect(resolveAboutInfo({ buildDate: 'not-a-date', commitShort: null }, '  ')).toBeUndefined();
  });

  it('never carries commit or branch on their own', () => {
    const info = {
      buildDate: '2026-10-29T08:00:00Z',
      commit: 'abcdef0123',
      commitShort: 'abcdef0',
      branch: 'main',
    };
    expect(resolveAboutInfo(info, undefined)).toEqual({ version: '2026-10-29 (sha-abcdef0)' });
  });
});
