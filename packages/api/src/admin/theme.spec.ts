import { getThemeWriteIssues, getThemeEntryWriteIssues } from './theme';

const theme = {
  version: 1,
  name: 'tenant-look',
  modes: {
    light: { colors: { 'rgb-surface-submit': '4 120 87' }, appearance: { radiusLg: '0.25rem' } },
    dark: { colors: { 'rgb-surface-submit': '52 211 153' } },
  },
};

const paths = (fields: Record<string, unknown>) =>
  getThemeWriteIssues(fields).map(({ path, code }) => ({ path, code }));

describe('getThemeWriteIssues', () => {
  it('accepts a paintable theme, a bundled theme name and writes without a theme', () => {
    expect(paths({ 'interface.theme': theme })).toEqual([]);
    expect(paths({ interface: { theme: 'clickhouse' } })).toEqual([]);
    expect(paths({ 'interface.customWelcome': 'Hi' })).toEqual([]);
    expect(paths({ 'interface.theme': null })).toEqual([]);
  });

  it('names each part of a theme the client would refuse', () => {
    const broken = {
      ...theme,
      version: 2,
      modes: {
        light: {
          colors: { 'rgb-surface-submit': 'green' },
          appearance: { radiusLg: 'very round' },
        },
      },
    };
    expect(paths({ 'interface.theme': broken })).toEqual(
      expect.arrayContaining([
        { path: 'interface.theme.version', code: 'theme_invalid' },
        { path: 'interface.theme.modes.light.colors.rgb-surface-submit', code: 'theme_invalid' },
        { path: 'interface.theme.modes.light.appearance.radiusLg', code: 'theme_invalid' },
      ]),
    );
    expect(paths({ interface: { theme: 'no-such-theme' } })).toEqual([
      { path: 'interface.theme', code: 'theme_invalid' },
    ]);
  });
});

describe('getThemeEntryWriteIssues', () => {
  const entryPaths = (segments: string[], value: unknown) =>
    getThemeEntryWriteIssues(segments, value).map(({ path }) => path);

  it('checks a whole theme or interface section addressed by segments', () => {
    expect(entryPaths(['interface', 'theme'], 'no-such-theme')).toEqual(['interface.theme']);
    expect(entryPaths(['interface'], { theme: 'no-such-theme' })).toEqual(['interface.theme']);
    expect(entryPaths([], { interface: { theme: 'no-such-theme' } })).toEqual(['interface.theme']);
  });

  it('leaves other writes, and writes of one field inside a theme, to the config load', () => {
    expect(entryPaths(['interface', 'theme'], theme)).toEqual([]);
    expect(entryPaths(['interface', 'theme', 'version'], 2)).toEqual([]);
    expect(entryPaths(['balance'], { enabled: true })).toEqual([]);
  });
});
