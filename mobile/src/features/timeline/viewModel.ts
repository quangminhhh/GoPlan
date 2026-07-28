import { resolvePlace } from '@/shared/location/resolvePlace';
import type {
  PlaceSuggestion,
  ResolvedPlaceLookup,
} from '@/shared/location/types';
import type {
  ActivityPlacePayload,
  TimelineActivity,
  TimelineSection,
} from './types';

const MINUTES_PER_DAY = 24 * 60;

const SECTION_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const UTC_TODAY_FORMATTER = createTodayFormatter('UTC');
const todayFormatterCache = new Map<string, Intl.DateTimeFormat>([
  ['UTC', UTC_TODAY_FORMATTER],
]);

export type TimelineActivityGroup = 'all-day' | 'scheduled' | 'flexible';

export interface GroupedTimelineActivities {
  allDay: TimelineActivity[];
  scheduled: TimelineActivity[];
  flexible: TimelineActivity[];
}

export interface TimelineGroupHeaderRow {
  type: 'group-header';
  key: string;
  group: TimelineActivityGroup;
  label: string;
}

export interface TimelineActivityRow {
  type: 'activity';
  key: string;
  group: TimelineActivityGroup;
  activity: TimelineActivity;
}

export interface TimelineEmptyRow {
  type: 'empty';
  key: string;
}

export type TimelineListRow =
  | TimelineGroupHeaderRow
  | TimelineActivityRow
  | TimelineEmptyRow;

export interface TimelineListSection {
  key: string;
  section: TimelineSection;
  data: TimelineListRow[];
}

export interface StructuredLocationValue {
  location_label: string;
  place: ActivityPlacePayload;
}

interface IndexedValue<T> {
  originalIndex: number;
  value: T;
}

const GROUP_LABELS: Record<TimelineActivityGroup, string> = {
  'all-day': 'All day',
  scheduled: 'Scheduled',
  flexible: 'Flexible',
};

export function sortTimelineSections(
  sections: readonly TimelineSection[],
): TimelineSection[] {
  return stableSort(sections, (left, right) => {
    const dateComparison = left.section_date.localeCompare(right.section_date);
    if (dateComparison !== 0) {
      return dateComparison;
    }
    return left.position - right.position;
  });
}

export function groupActivitiesForDay(
  activities: readonly TimelineActivity[],
): GroupedTimelineActivities {
  const allDay: TimelineActivity[] = [];
  const scheduled: TimelineActivity[] = [];
  const flexible: TimelineActivity[] = [];

  for (const activity of activities) {
    if (activity.time_mode === 'ALL_DAY') {
      allDay.push(activity);
    } else if (activity.time_mode === 'FLEXIBLE') {
      flexible.push(activity);
    } else {
      scheduled.push(activity);
    }
  }

  return {
    allDay: stableSort(allDay, compareByPosition),
    scheduled: stableSort(scheduled, compareScheduledActivities),
    flexible: stableSort(flexible, compareByPosition),
  };
}

export function buildTimelineListSections(
  sections: readonly TimelineSection[],
): TimelineListSection[] {
  return sortTimelineSections(sections).map((section) => {
    const groups = groupActivitiesForDay(section.activities);
    const data: TimelineListRow[] = [];

    appendActivityGroup(data, section.id, 'all-day', groups.allDay);
    appendActivityGroup(data, section.id, 'scheduled', groups.scheduled);
    appendActivityGroup(data, section.id, 'flexible', groups.flexible);

    if (data.length === 0) {
      data.push({
        type: 'empty',
        key: `empty:${section.id}`,
      });
    }

    return {
      key: `section:${section.id}`,
      section,
      data,
    };
  });
}

export function getTimelineRowKey(row: TimelineListRow): string {
  return row.key;
}

export function getTodayDateInTimeZone(
  timeZone: string,
  now = new Date(),
): string {
  const formatter = getTodayFormatter(timeZone);
  const parts = formatter.formatToParts(now);
  const year = getDatePart(parts, 'year', '0000');
  const month = getDatePart(parts, 'month', '01');
  const day = getDatePart(parts, 'day', '01');
  return `${year}-${month}-${day}`;
}

export function getDefaultFocusedSectionId(
  sections: readonly TimelineSection[],
  timeZone: string,
  now = new Date(),
): string | null {
  if (sections.length === 0) {
    return null;
  }

  const sortedSections = sortTimelineSections(sections);
  const today = getTodayDateInTimeZone(timeZone, now);
  const todaySection = sortedSections.find(
    (section) => section.section_date === today,
  );
  if (todaySection) {
    return todaySection.id;
  }

  const inRangeSections = sortedSections.filter(
    (section) => section.is_in_trip_range,
  );
  if (inRangeSections.length > 0) {
    const firstInRange = inRangeSections[0];
    const lastInRange = inRangeSections[inRangeSections.length - 1];

    if (today < firstInRange.section_date) {
      return firstInRange.id;
    }
    if (today > lastInRange.section_date) {
      return lastInRange.id;
    }
    return firstInRange.id;
  }

  const firstSection = sortedSections[0];
  if (today < firstSection.section_date) {
    return firstSection.id;
  }

  const lastSection = sortedSections[sortedSections.length - 1];
  if (today > lastSection.section_date) {
    return lastSection.id;
  }

  return firstSection.id;
}

export function getDefaultFocusedSectionIndex(
  sections: readonly TimelineListSection[],
  timeZone: string,
  now = new Date(),
): number | null {
  const sectionId = getDefaultFocusedSectionId(
    sections.map((section) => section.section),
    timeZone,
    now,
  );
  if (sectionId === null) {
    return null;
  }

  const index = sections.findIndex((section) => section.section.id === sectionId);
  return index >= 0 ? index : null;
}

export function formatSectionDate(sectionDate: string): string {
  const date = parseIsoDate(sectionDate);
  return date ? SECTION_DATE_FORMATTER.format(date) : sectionDate;
}

export function formatTime(time: string | null): string {
  if (time === null) {
    return '';
  }
  return time.slice(0, 5);
}

export function formatActivityTime(activity: TimelineActivity): string {
  if (activity.time_mode === 'ALL_DAY') {
    return 'All day';
  }
  if (activity.time_mode === 'FLEXIBLE') {
    return 'Flexible';
  }

  const start = formatTime(activity.start_time);
  if (activity.time_mode === 'AT_TIME') {
    return start;
  }

  const end = formatTime(activity.end_time);
  if (start && end) {
    return `${start} – ${end}`;
  }
  return start || end;
}

export function buildStructuredLocation(
  suggestion: PlaceSuggestion,
  lookup: ResolvedPlaceLookup,
): StructuredLocationValue | null {
  const place = resolvePlace(suggestion, lookup);
  if (!place) {
    return null;
  }
  // The shared caps already match the activity caps; this mapping is a rename,
  // not a second truncation pass.
  return {
    location_label: place.label,
    place: {
      provider: place.provider,
      provider_id: place.provider_id,
      title: place.label,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
    },
  };
}

function stableSort<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  return values
    .map<IndexedValue<T>>((value, originalIndex) => ({
      value,
      originalIndex,
    }))
    .sort((left, right) => {
      const comparison = compare(left.value, right.value);
      return comparison !== 0 ? comparison : left.originalIndex - right.originalIndex;
    })
    .map(({ value }) => value);
}

function compareByPosition(
  left: TimelineActivity,
  right: TimelineActivity,
): number {
  return left.position - right.position;
}

function compareScheduledActivities(
  left: TimelineActivity,
  right: TimelineActivity,
): number {
  const startComparison =
    timeToMinutes(left.start_time) - timeToMinutes(right.start_time);
  if (startComparison !== 0) {
    return startComparison;
  }
  return compareByPosition(left, right);
}

function timeToMinutes(value: string | null): number {
  if (value === null) {
    return MINUTES_PER_DAY;
  }

  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) {
    return MINUTES_PER_DAY;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return MINUTES_PER_DAY;
  }
  return hour * 60 + minute;
}

function appendActivityGroup(
  rows: TimelineListRow[],
  sectionId: string,
  group: TimelineActivityGroup,
  activities: readonly TimelineActivity[],
): void {
  if (activities.length === 0) {
    return;
  }

  rows.push({
    type: 'group-header',
    key: `group:${sectionId}:${group}`,
    group,
    label: GROUP_LABELS[group],
  });

  for (const activity of activities) {
    rows.push({
      type: 'activity',
      key: `activity:${sectionId}:${activity.id}`,
      group,
      activity,
    });
  }
}

function createTodayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function getTodayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = todayFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  try {
    const formatter = createTodayFormatter(timeZone);
    todayFormatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return UTC_TODAY_FORMATTER;
  }
}

function getDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
  fallback: string,
): string {
  return parts.find((part) => part.type === type)?.value ?? fallback;
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
