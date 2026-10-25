import { brandingSchema, isBrandingImage, MAX_BRANDING_IMAGE_LENGTH } from './branding';
import { interfaceSchema } from './config';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('isBrandingImage', () => {
  it('accepts https URLs and inline base64 images', () => {
    expect(isBrandingImage('https://cdn.example.com/logo.svg')).toBe(true);
    expect(isBrandingImage(PNG)).toBe(true);
    expect(isBrandingImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(true);
  });

  it('rejects other schemes, other data types and oversized images', () => {
    expect(isBrandingImage('http://example.com/logo.png')).toBe(false);
    expect(isBrandingImage('javascript:alert(1)')).toBe(false);
    expect(isBrandingImage('data:text/html;base64,PGgxPg==')).toBe(false);
    expect(isBrandingImage('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false);
    expect(isBrandingImage('assets/logo.svg')).toBe(false);
    expect(isBrandingImage(`data:image/png;base64,${'A'.repeat(MAX_BRANDING_IMAGE_LENGTH)}`)).toBe(
      false,
    );
  });
});

describe('brandingSchema', () => {
  it('parses a full branding under interface', () => {
    const branding = {
      appTitle: ' Acme AI ',
      logo: PNG,
      favicon: PNG,
      footer: 'Acme | [Help](https://acme.example)',
    };
    expect(interfaceSchema.parse({ branding }).branding).toEqual({
      ...branding,
      appTitle: 'Acme AI',
    });
  });

  it('rejects unknown keys, blank or long titles and bad images', () => {
    expect(brandingSchema.safeParse({ color: '#fff' }).success).toBe(false);
    expect(brandingSchema.safeParse({ appTitle: '  ' }).success).toBe(false);
    expect(brandingSchema.safeParse({ appTitle: 'x'.repeat(61) }).success).toBe(false);
    expect(brandingSchema.safeParse({ logo: 'http://acme.example/logo.png' }).success).toBe(false);
  });

  it('accepts a description for link previews up to 200 characters', () => {
    expect(brandingSchema.parse({ description: ' AI for teams ' })).toEqual({
      description: 'AI for teams',
    });
    expect(brandingSchema.safeParse({ description: 'x'.repeat(201) }).success).toBe(false);
  });
});
