import { injectShellTitle } from './title';

const SHELL =
  '<!doctype html><html><head><meta charset="utf-8" />' +
  '<meta\n      name="description"\n      content="LibreChat - An open source chat application"\n    />' +
  '<title>LibreChat</title></head><body><div id="root"></div></body></html>';

const ogOf = (html: string, property: string): string | undefined =>
  new RegExp(`<meta property="og:${property}" content="([^"]*)"`).exec(html)?.[1];

describe('injectShellTitle', () => {
  it('leaves the shell as upstream ships it without a title', () => {
    expect(injectShellTitle(SHELL)).toBe(SHELL);
    expect(injectShellTitle(SHELL, { title: '  ' })).toBe(SHELL);
    expect(injectShellTitle(SHELL, { description: 'Only a description' })).toBe(SHELL);
  });

  it('names the deployment in the title, description and Open Graph tags', () => {
    const html = injectShellTitle(SHELL, { title: 'OfficeChat', description: 'KI für Teams' });

    expect(html).toContain('<title>OfficeChat</title>');
    expect(html).toContain('<meta name="description" content="KI für Teams" />');
    expect(ogOf(html, 'site_name')).toBe('OfficeChat');
    expect(ogOf(html, 'title')).toBe('OfficeChat');
    expect(ogOf(html, 'description')).toBe('KI für Teams');
    expect(html).not.toContain('LibreChat');
  });

  it('uses the title as description when none is configured', () => {
    const html = injectShellTitle(SHELL, { title: 'OfficeChat' });

    expect(html).toContain('<meta name="description" content="OfficeChat" />');
    expect(ogOf(html, 'description')).toBe('OfficeChat');
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });

  it('adds the tags to a shell without a description', () => {
    const html = injectShellTitle('<html><head><title>LibreChat</title></head></html>', {
      title: 'OfficeChat',
    });

    expect(html).toContain('<meta property="og:description" content="OfficeChat" /></head>');
    expect(ogOf(html, 'title')).toBe('OfficeChat');
  });

  it('escapes markup and replacement patterns in configured text', () => {
    const html = injectShellTitle(SHELL, { title: 'A&B "<x>" $&', description: "it's $1" });

    expect(html).toContain('<title>A&amp;B &quot;&lt;x&gt;&quot; $&amp;</title>');
    expect(ogOf(html, 'description')).toBe('it&#39;s $1');
    expect(html).not.toContain('<x>');
  });
});
