import type {
  PlaceSuggestion,
  ResolvedPlaceLookup,
} from '@/shared/location/types';
import type {
  TimelineActivity,
  TimelineSection,
} from '../types';
import {
  buildStructuredLocation,
  buildTimelineListSections,
  formatActivityTime,
  formatSectionDate,
  getDefaultFocusedSectionId,
  getDefaultFocusedSectionIndex,
  getTimelineRowKey,
  getTodayDateInTimeZone,
  groupActivitiesForDay,
  sortTimelineSections,
} from '../viewModel';

function buildActivity(
  overrides: Partial<TimelineActivity> = {},
): TimelineActivity {
  return {
    id: 'activity-1',
    title: 'Sample activity',
    time_mode: 'AT_TIME',
    start_time: '09:00:00',
    end_time: null,
    status: 'UPCOMING',
    position: 0,
    activity_type: {
      kind: 'SYSTEM',
      code: 'OTHER',
      label: 'Other',
      color_token: 'slate',
      icon_key: 'tag',
    },
    assignee_scope: 'NONE',
    assignee: null,
    location: {
      location_mode: 'MANUAL',
      location_label: '',
      location_note: '',
      place: null,
      open_url: null,
    },
    note: '',
    meeting_point: '',
    contact_name: '',
    contact_phone: '',
    booking_reference: '',
    external_link: '',
    reminder_offsets_minutes: [],
    capabilities: {
      can_edit: false,
      can_delete: false,
      can_update_status: false,
    },
    ...overrides,
  };
}

function buildSection(
  overrides: Partial<TimelineSection> = {},
): TimelineSection {
  return {
    id: 'section-1',
    section_date: '2026-06-01',
    label: 'Day 1',
    is_label_custom: false,
    is_in_trip_range: true,
    position: 0,
    activities: [],
    ...overrides,
  };
}

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

describe('timeline view model ordering', () => {
  it('sorts sections by date, position, then original aggregate order', () => {
    const sections = [
      buildSection({
        id: 'same-first',
        section_date: '2026-06-02',
        position: 1,
        label: 'Zulu',
      }),
      buildSection({
        id: 'later-position',
        section_date: '2026-06-02',
        position: 2,
        label: 'Alpha',
      }),
      buildSection({
        id: 'earlier-date',
        section_date: '2026-06-01',
        position: 99,
      }),
      buildSection({
        id: 'same-second',
        section_date: '2026-06-02',
        position: 1,
        label: 'Alpha',
      }),
    ];

    expect(sortTimelineSections(sections).map((section) => section.id)).toEqual([
      'earlier-date',
      'same-first',
      'same-second',
      'later-position',
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      'same-first',
      'later-position',
      'earlier-date',
      'same-second',
    ]);
  });

  it('groups and stably sorts all-day, scheduled, and flexible activities', () => {
    const activities = [
      buildActivity({
        id: 'flex-first',
        title: 'Zulu',
        time_mode: 'FLEXIBLE',
        start_time: null,
        position: 2,
      }),
      buildActivity({
        id: 'scheduled-same-first',
        title: 'Zulu',
        start_time: '09:00:00',
        position: 1,
      }),
      buildActivity({
        id: 'all-day-later',
        time_mode: 'ALL_DAY',
        start_time: null,
        position: 5,
      }),
      buildActivity({
        id: 'scheduled-null',
        start_time: null,
        position: 0,
      }),
      buildActivity({
        id: 'all-day-earlier',
        time_mode: 'ALL_DAY',
        start_time: null,
        position: 1,
      }),
      buildActivity({
        id: 'scheduled-earlier',
        start_time: '08:00:00',
        position: 9,
      }),
      buildActivity({
        id: 'scheduled-same-second',
        title: 'Alpha',
        start_time: '09:00:00',
        position: 1,
      }),
      buildActivity({
        id: 'flex-second',
        title: 'Alpha',
        time_mode: 'FLEXIBLE',
        start_time: null,
        position: 2,
      }),
    ];

    const groups = groupActivitiesForDay(activities);

    expect(groups.allDay.map((activity) => activity.id)).toEqual([
      'all-day-earlier',
      'all-day-later',
    ]);
    expect(groups.scheduled.map((activity) => activity.id)).toEqual([
      'scheduled-earlier',
      'scheduled-same-first',
      'scheduled-same-second',
      'scheduled-null',
    ]);
    expect(groups.flexible.map((activity) => activity.id)).toEqual([
      'flex-first',
      'flex-second',
    ]);
  });

  it('builds typed SectionList rows with deterministic stable keys', () => {
    const listSections = buildTimelineListSections([
      buildSection({
        id: 'day-2',
        section_date: '2026-06-02',
        activities: [],
      }),
      buildSection({
        id: 'day-1',
        section_date: '2026-06-01',
        activities: [
          buildActivity({
            id: 'all-day',
            time_mode: 'ALL_DAY',
            start_time: null,
          }),
          buildActivity({ id: 'breakfast', start_time: '08:00:00' }),
          buildActivity({
            id: 'shopping',
            time_mode: 'FLEXIBLE',
            start_time: null,
          }),
        ],
      }),
    ]);

    expect(listSections.map((section) => section.key)).toEqual([
      'section:day-1',
      'section:day-2',
    ]);
    expect(listSections[0].data.map(getTimelineRowKey)).toEqual([
      'group:day-1:all-day',
      'activity:day-1:all-day',
      'group:day-1:scheduled',
      'activity:day-1:breakfast',
      'group:day-1:flexible',
      'activity:day-1:shopping',
    ]);
    expect(listSections[1].data).toEqual([
      { type: 'empty', key: 'empty:day-2' },
    ]);
  });
});

describe('timeline today target', () => {
  it('computes today in the trip timezone at a UTC date boundary', () => {
    const now = new Date('2026-06-01T17:30:00.000Z');

    expect(getTodayDateInTimeZone('Asia/Ho_Chi_Minh', now)).toBe('2026-06-02');
    expect(getTodayDateInTimeZone('America/Los_Angeles', now)).toBe(
      '2026-06-01',
    );
  });

  it('focuses today before applying in-range boundaries', () => {
    const sections = [
      buildSection({ id: 'day-1', section_date: '2026-06-01' }),
      buildSection({
        id: 'extra-day',
        section_date: '2026-06-02',
        is_in_trip_range: false,
      }),
    ];

    expect(
      getDefaultFocusedSectionId(
        sections,
        'Asia/Ho_Chi_Minh',
        new Date('2026-06-01T17:30:00.000Z'),
      ),
    ).toBe('extra-day');
  });

  it('targets the nearest in-range boundary before and after the trip', () => {
    const sections = [
      buildSection({
        id: 'pre-trip',
        section_date: '2026-05-31',
        is_in_trip_range: false,
      }),
      buildSection({ id: 'day-1', section_date: '2026-06-01' }),
      buildSection({ id: 'day-2', section_date: '2026-06-02' }),
      buildSection({
        id: 'post-trip',
        section_date: '2026-06-03',
        is_in_trip_range: false,
      }),
    ];

    expect(
      getDefaultFocusedSectionId(
        sections,
        'UTC',
        new Date('2026-05-20T12:00:00.000Z'),
      ),
    ).toBe('day-1');
    expect(
      getDefaultFocusedSectionId(
        sections,
        'UTC',
        new Date('2026-06-20T12:00:00.000Z'),
      ),
    ).toBe('day-2');
  });

  it('returns an index aligned with the sorted SectionList sections', () => {
    const listSections = buildTimelineListSections([
      buildSection({ id: 'day-2', section_date: '2026-06-02' }),
      buildSection({ id: 'day-1', section_date: '2026-06-01' }),
    ]);

    expect(
      getDefaultFocusedSectionIndex(
        listSections,
        'UTC',
        new Date('2026-06-02T12:00:00.000Z'),
      ),
    ).toBe(1);
    expect(getDefaultFocusedSectionIndex([], 'UTC')).toBeNull();
  });
});

describe('timeline formatting', () => {
  it('formats date-only values without shifting them through a local timezone', () => {
    expect(formatSectionDate('2026-05-31')).toBe('Sun, May 31, 2026');
    expect(formatSectionDate('not-a-date')).toBe('not-a-date');
  });

  it.each([
    [
      buildActivity({
        time_mode: 'ALL_DAY',
        start_time: null,
        end_time: null,
      }),
      'All day',
    ],
    [
      buildActivity({
        time_mode: 'FLEXIBLE',
        start_time: null,
        end_time: null,
      }),
      'Flexible',
    ],
    [buildActivity({ start_time: '09:05:00' }), '09:05'],
    [
      buildActivity({
        time_mode: 'TIME_RANGE',
        start_time: '09:05:00',
        end_time: '10:45:00',
      }),
      '09:05 – 10:45',
    ],
  ])('formats activity time labels', (activity, expected) => {
    expect(formatActivityTime(activity)).toBe(expected);
  });
});

describe('buildStructuredLocation', () => {
  it('uses only the successful canonical lookup id and canonical lookup values', () => {
    expect(buildStructuredLocation(suggestion, buildLookup())).toEqual({
      location_label: 'Hội An',
      place: {
        provider: 'here',
        provider_id: 'canonical-here-id',
        title: 'Hội An',
        address: 'Hội An, Quảng Nam, Việt Nam',
        lat: 15.8801,
        lng: 108.338,
      },
    });
  });

  it('truncates title and address to backend code-point caps', () => {
    const title = '😀'.repeat(201);
    const destination = 'Đ'.repeat(256);
    const result = buildStructuredLocation(
      { ...suggestion, title },
      buildLookup({ destination }),
    );

    expect(Array.from(result?.location_label ?? '')).toHaveLength(200);
    expect(Array.from(result?.place.title ?? '')).toHaveLength(200);
    expect(Array.from(result?.place.address ?? '')).toHaveLength(255);
  });

  it.each([
    '',
    '   ',
    'x'.repeat(256),
  ])('rejects invalid canonical id %p without suggestion-id fallback', (id) => {
    expect(
      buildStructuredLocation(
        suggestion,
        buildLookup({ destination_provider_id: id }),
      ),
    ).toBeNull();
  });

  it('accepts a canonical id exactly at the 255-character cap', () => {
    const id = 'x'.repeat(255);
    expect(
      buildStructuredLocation(
        suggestion,
        buildLookup({ destination_provider_id: id }),
      )?.place.provider_id,
    ).toBe(id);
  });
});
