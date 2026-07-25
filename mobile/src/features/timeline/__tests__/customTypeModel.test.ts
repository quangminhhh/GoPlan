import {
  buildCreateCustomTypePayload,
  buildPatchCustomTypePayload,
  createCustomTypeDraft,
  hydrateCustomTypeDraft,
  validateCustomTypeDraft,
} from '../customTypeModel';
import {
  DEFAULT_TIMELINE_COLOR_TOKEN,
  DEFAULT_TIMELINE_ICON_KEY,
} from '../tokenMaps';
import type { TimelineCustomTypeMeta } from '../types';

const customType: TimelineCustomTypeMeta = {
  id: 'a0a81541-080e-4f33-ac10-b5e994e41c69',
  name: 'Coffee stop',
  normalized_name: 'coffee-stop',
  color_token: 'brand-gold',
  icon_key: 'rocket',
  is_active: false,
};

describe('customTypeModel', () => {
  it('creates a draft from the centralized supported defaults', () => {
    expect(createCustomTypeDraft()).toEqual({
      name: '',
      color_token: DEFAULT_TIMELINE_COLOR_TOKEN,
      icon_key: DEFAULT_TIMELINE_ICON_KEY,
    });
  });

  it('validates required and code-point name limits', () => {
    expect(
      validateCustomTypeDraft({
        ...createCustomTypeDraft(),
        name: '   ',
      }),
    ).toEqual({
      isValid: false,
      fieldErrors: { name: 'Name is required.' },
    });
    expect(
      validateCustomTypeDraft({
        ...createCustomTypeDraft(),
        name: '😀'.repeat(41),
      }).fieldErrors.name,
    ).toBe('Name must be 40 characters or fewer.');
  });

  it('normalizes a create payload and includes only supported picker values', () => {
    expect(
      buildCreateCustomTypePayload({
        name: '  Coffee break  ',
        color_token: 'amber',
        icon_key: 'utensils',
      }),
    ).toEqual({
      name: 'Coffee break',
      color_token: 'amber',
      icon_key: 'utensils',
    });
    expect(
      buildCreateCustomTypePayload({
        name: 'Coffee break',
        color_token: 'unknown',
        icon_key: 'utensils',
      }),
    ).toBeNull();
  });

  it('hydrates unknown server tokens without replacing them', () => {
    expect(hydrateCustomTypeDraft(customType)).toEqual({
      name: 'Coffee stop',
      color_token: 'brand-gold',
      icon_key: 'rocket',
    });
  });

  it('omits unchanged unknown tokens from a minimal rename PATCH', () => {
    const initial = hydrateCustomTypeDraft(customType);

    expect(
      buildPatchCustomTypePayload(initial, {
        ...initial,
        name: '  Coffee and tea  ',
      }),
    ).toEqual({ name: 'Coffee and tea' });
  });

  it('includes supported token replacements and returns an empty no-op PATCH', () => {
    const initial = hydrateCustomTypeDraft(customType);

    expect(
      buildPatchCustomTypePayload(initial, {
        ...initial,
        color_token: 'rose',
        icon_key: 'bus',
      }),
    ).toEqual({
      color_token: 'rose',
      icon_key: 'bus',
    });
    expect(buildPatchCustomTypePayload(initial, { ...initial })).toEqual({});
  });
});
