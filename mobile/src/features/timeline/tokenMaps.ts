import { type ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/shared/theme/tokens';

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export const TIMELINE_COLOR_TOKENS = [
  'sky',
  'amber',
  'rose',
  'emerald',
  'violet',
  'indigo',
  'teal',
  'slate',
] as const;

export type TimelineColorToken = (typeof TIMELINE_COLOR_TOKENS)[number];

export interface TimelineTokenColors {
  color: string;
  backgroundColor: string;
}

const COLOR_MAP: Record<TimelineColorToken, TimelineTokenColors> = {
  sky: { color: colors.sky, backgroundColor: colors.skySoft },
  amber: { color: colors.amber, backgroundColor: colors.amberSoft },
  rose: { color: colors.rose, backgroundColor: colors.roseSoft },
  emerald: { color: colors.emerald, backgroundColor: colors.emeraldSoft },
  violet: { color: colors.violet, backgroundColor: colors.violetSoft },
  indigo: { color: colors.indigo, backgroundColor: colors.indigoSoft },
  teal: { color: colors.teal, backgroundColor: colors.tealSoft },
  slate: { color: colors.slate, backgroundColor: colors.slateSoft },
};

export const TIMELINE_COLOR_OPTIONS = TIMELINE_COLOR_TOKENS.map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
  ...COLOR_MAP[value],
}));

export function getTimelineTokenColors(value: string | null | undefined): TimelineTokenColors {
  if (value && hasOwn(COLOR_MAP, value)) {
    return COLOR_MAP[value];
  }
  return COLOR_MAP.slate;
}

export const TIMELINE_ICON_KEYS = [
  'bus',
  'bed',
  'utensils',
  'camera',
  'shopping-bag',
  'key',
  'smile',
  'tag',
] as const;

export type TimelineIconKey = (typeof TIMELINE_ICON_KEYS)[number];
export type TimelineIconName = ComponentProps<typeof Ionicons>['name'];

const ICON_MAP: Record<TimelineIconKey, TimelineIconName> = {
  bus: 'bus-outline',
  bed: 'bed-outline',
  utensils: 'restaurant-outline',
  camera: 'camera-outline',
  'shopping-bag': 'bag-outline',
  key: 'key-outline',
  smile: 'happy-outline',
  tag: 'pricetag-outline',
};

const ICON_LABELS: Record<TimelineIconKey, string> = {
  bus: 'Transport',
  bed: 'Stay',
  utensils: 'Food',
  camera: 'Sightseeing',
  'shopping-bag': 'Shopping',
  key: 'Booking',
  smile: 'Leisure',
  tag: 'Other',
};

export const TIMELINE_ICON_OPTIONS = TIMELINE_ICON_KEYS.map((value) => ({
  value,
  label: ICON_LABELS[value],
  icon: ICON_MAP[value],
}));

export function getTimelineIconName(value: string | null | undefined): TimelineIconName {
  if (value && hasOwn(ICON_MAP, value)) {
    return ICON_MAP[value];
  }
  return ICON_MAP.tag;
}
