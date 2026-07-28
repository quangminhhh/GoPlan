import {
  getTimelineIconName,
  getTimelineTokenColors,
  TIMELINE_COLOR_OPTIONS,
  TIMELINE_COLOR_TOKENS,
  TIMELINE_ICON_KEYS,
  TIMELINE_ICON_OPTIONS,
} from '../tokenMaps';

describe('timeline token maps', () => {
  it('offers each supported color and icon exactly once', () => {
    expect(TIMELINE_COLOR_OPTIONS.map((option) => option.value)).toEqual(
      TIMELINE_COLOR_TOKENS,
    );
    expect(TIMELINE_ICON_OPTIONS.map((option) => option.value)).toEqual(
      TIMELINE_ICON_KEYS,
    );
    expect(new Set(TIMELINE_COLOR_TOKENS).size).toBe(8);
    expect(new Set(TIMELINE_ICON_KEYS).size).toBe(8);
  });

  it('falls back to a neutral slate token and tag icon for unknown values', () => {
    expect(getTimelineTokenColors('future-token')).toEqual(
      getTimelineTokenColors('slate'),
    );
    expect(getTimelineIconName('future-icon')).toBe('pricetag-outline');
  });

  it('maps the known server icon keys to Ionicons names', () => {
    expect(getTimelineIconName('bus')).toBe('bus-outline');
    expect(getTimelineIconName('utensils')).toBe('restaurant-outline');
    expect(getTimelineIconName('shopping-bag')).toBe('bag-outline');
  });
});
