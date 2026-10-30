import { effectiveLocation, locationSchema } from './location';

describe('locationSchema', () => {
  it('takes a country code, the EU or anywhere, and upper-cases the code', () => {
    expect(locationSchema.parse({ type: 'country', code: 'fr' })).toEqual({
      type: 'country',
      code: 'FR',
    });
    expect(locationSchema.parse({ type: 'eu' })).toEqual({ type: 'eu' });
    expect(locationSchema.parse({ type: 'global' })).toEqual({ type: 'global' });
  });

  it('refuses other shapes', () => {
    for (const value of [
      { type: 'country', code: 'FRA' },
      { type: 'country' },
      { type: 'eu', code: 'DE' },
      { type: 'region', name: 'EU' },
      'FR',
    ]) {
      expect(locationSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('effectiveLocation', () => {
  it("takes the model's own location over its provider's", () => {
    const provider = { location: { type: 'country' as const, code: 'FR' } };
    expect(effectiveLocation({ location: { type: 'eu' } }, provider)).toEqual({ type: 'eu' });
    expect(effectiveLocation({}, provider)).toEqual(provider.location);
    expect(effectiveLocation({}, {})).toBeUndefined();
  });
});
