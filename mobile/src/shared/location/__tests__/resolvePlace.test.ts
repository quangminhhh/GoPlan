import {
  codePointLength,
  resolvePlace,
  truncateCodePoints,
} from '../resolvePlace';
import type { PlaceSuggestion, ResolvedPlaceLookup } from '../types';

const suggestion: PlaceSuggestion = {
  provider: 'here',
  provider_id: 'unverified-suggestion-id',
  title: 'Hội An',
  subtitle: 'Quảng Nam, Việt Nam',
};

function buildLookup(
  overrides: Partial<ResolvedPlaceLookup> = {},
): ResolvedPlaceLookup {
  return {
    destination: 'Hội An, Quảng Nam, Việt Nam',
    destination_provider: 'here',
    destination_provider_id: 'canonical-here-id',
    destination_lat: 15.8801,
    destination_lng: 108.338,
    destination_country_code: 'VN',
    ...overrides,
  };
}

describe('code point helpers', () => {
  it('counts and truncates astral-plane characters as single units', () => {
    expect(codePointLength('😀😀😀')).toBe(3);
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(truncateCodePoints('Hội An', 20)).toBe('Hội An');
  });
});

describe('resolvePlace', () => {
  it('uses only the successful canonical lookup id and canonical lookup values', () => {
    expect(resolvePlace(suggestion, buildLookup())).toEqual({
      provider: 'here',
      provider_id: 'canonical-here-id',
      label: 'Hội An',
      address: 'Hội An, Quảng Nam, Việt Nam',
      lat: 15.8801,
      lng: 108.338,
      country_code: 'VN',
    });
  });

  it('truncates label and address to backend code-point caps', () => {
    const title = '😀'.repeat(201);
    const destination = 'Đ'.repeat(256);
    const result = resolvePlace(
      { ...suggestion, title },
      buildLookup({ destination }),
    );

    expect(Array.from(result?.label ?? '')).toHaveLength(200);
    expect(Array.from(result?.address ?? '')).toHaveLength(255);
  });

  it('falls back to the suggestion subtitle when the lookup carries no address', () => {
    // The `??` in resolvePlace guards a runtime shape the declared type forbids,
    // so reaching that branch at all requires stepping outside the type once.
    const result = resolvePlace(
      suggestion,
      buildLookup({ destination: undefined as unknown as string }),
    );

    expect(result?.address).toBe(suggestion.subtitle);
  });

  it.each([
    '',
    '   ',
    'x'.repeat(256),
  ])('rejects invalid canonical id %p without suggestion-id fallback', (id) => {
    expect(
      resolvePlace(suggestion, buildLookup({ destination_provider_id: id })),
    ).toBeNull();
  });

  it('accepts a canonical id exactly at the 255-character cap', () => {
    const id = 'x'.repeat(255);
    expect(
      resolvePlace(suggestion, buildLookup({ destination_provider_id: id }))
        ?.provider_id,
    ).toBe(id);
  });

  it('keeps null coordinates null instead of coercing them to zero', () => {
    const result = resolvePlace(
      suggestion,
      buildLookup({ destination_lat: null, destination_lng: null }),
    );

    expect(result?.lat).toBeNull();
    expect(result?.lng).toBeNull();
  });

  it.each([
    ['a three-letter code', 'VNM'],
    ['an empty code', ''],
  ])('drops %s that the destination column cannot store', (_case, code) => {
    expect(
      resolvePlace(
        suggestion,
        buildLookup({ destination_country_code: code }),
      )?.country_code,
    ).toBe('');
  });
});
