import {
  parseActivityFormRouteIntent,
  parseSectionFormRouteIntent,
  parseTimelineRouteIntent,
  type ActivityFormRouteParams,
  type SectionFormRouteParams,
  type TimelineRouteParam,
} from '../routeIntent';

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const SECTION_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const ACTIVITY_ID = 'a11957b3-3329-4fcf-9c7b-673a51c1d8a7';

const INVALID_UUID_PARAMS: TimelineRouteParam[] = [
  undefined,
  '',
  '   ',
  ` ${TRIP_ID}`,
  `${TRIP_ID} `,
  'not-a-uuid',
  '123e4567e89b12d3a456426614174000',
  [TRIP_ID],
];

describe('parseTimelineRouteIntent', () => {
  it('accepts one canonical UUID string', () => {
    expect(parseTimelineRouteIntent({ tripId: TRIP_ID })).toEqual({ tripId: TRIP_ID });
    expect(parseTimelineRouteIntent({ tripId: TRIP_ID.toUpperCase() })).toEqual({
      tripId: TRIP_ID,
    });
  });

  it.each(INVALID_UUID_PARAMS)('rejects invalid tripId %#', (tripId) => {
    expect(parseTimelineRouteIntent({ tripId })).toBeNull();
  });
});

describe('parseSectionFormRouteIntent', () => {
  const createParams: SectionFormRouteParams = {
    tripId: TRIP_ID,
    mode: 'create',
    sectionId: undefined,
  };
  const editParams: SectionFormRouteParams = {
    tripId: TRIP_ID,
    mode: 'edit',
    sectionId: SECTION_ID,
  };

  it('returns strict create and edit discriminants', () => {
    expect(parseSectionFormRouteIntent(createParams)).toEqual({
      mode: 'create',
      tripId: TRIP_ID,
    });
    expect(parseSectionFormRouteIntent(editParams)).toEqual({
      mode: 'edit',
      tripId: TRIP_ID,
      sectionId: SECTION_ID,
    });
    expect(
      parseSectionFormRouteIntent({
        ...editParams,
        tripId: TRIP_ID.toUpperCase(),
        sectionId: SECTION_ID.toUpperCase(),
      }),
    ).toEqual({
      mode: 'edit',
      tripId: TRIP_ID,
      sectionId: SECTION_ID,
    });
  });

  it.each(INVALID_UUID_PARAMS)('rejects invalid tripId %#', (tripId) => {
    expect(parseSectionFormRouteIntent({ ...createParams, tripId })).toBeNull();
  });

  it.each([undefined, '', 'CREATE', 'unknown', ['create']] as TimelineRouteParam[])(
    'rejects missing, blank, unknown, or array mode %#',
    (mode) => {
      expect(parseSectionFormRouteIntent({ ...createParams, mode })).toBeNull();
    },
  );

  it.each(['', 'not-a-uuid', SECTION_ID, [SECTION_ID]] as TimelineRouteParam[])(
    'rejects create intent with any sectionId %#',
    (sectionId) => {
      expect(parseSectionFormRouteIntent({ ...createParams, sectionId })).toBeNull();
    },
  );

  it.each(INVALID_UUID_PARAMS)(
    'rejects edit intent without exactly one valid sectionId %#',
    (sectionId) => {
      expect(parseSectionFormRouteIntent({ ...editParams, sectionId })).toBeNull();
    },
  );
});

describe('parseActivityFormRouteIntent', () => {
  const createParams: ActivityFormRouteParams = {
    tripId: TRIP_ID,
    mode: 'create',
    sectionId: SECTION_ID,
    activityId: undefined,
  };
  const editParams: ActivityFormRouteParams = {
    tripId: TRIP_ID,
    mode: 'edit',
    sectionId: undefined,
    activityId: ACTIVITY_ID,
  };

  it('returns strict create and edit discriminants', () => {
    expect(parseActivityFormRouteIntent(createParams)).toEqual({
      mode: 'create',
      tripId: TRIP_ID,
      sectionId: SECTION_ID,
    });
    expect(parseActivityFormRouteIntent(editParams)).toEqual({
      mode: 'edit',
      tripId: TRIP_ID,
      activityId: ACTIVITY_ID,
    });
    expect(
      parseActivityFormRouteIntent({
        ...createParams,
        tripId: TRIP_ID.toUpperCase(),
        sectionId: SECTION_ID.toUpperCase(),
      }),
    ).toEqual({
      mode: 'create',
      tripId: TRIP_ID,
      sectionId: SECTION_ID,
    });
    expect(
      parseActivityFormRouteIntent({
        ...editParams,
        tripId: TRIP_ID.toUpperCase(),
        activityId: ACTIVITY_ID.toUpperCase(),
      }),
    ).toEqual({
      mode: 'edit',
      tripId: TRIP_ID,
      activityId: ACTIVITY_ID,
    });
  });

  it.each(INVALID_UUID_PARAMS)('rejects invalid tripId %#', (tripId) => {
    expect(parseActivityFormRouteIntent({ ...createParams, tripId })).toBeNull();
  });

  it.each([undefined, '', 'EDIT', 'unknown', ['edit']] as TimelineRouteParam[])(
    'rejects missing, blank, unknown, or array mode %#',
    (mode) => {
      expect(parseActivityFormRouteIntent({ ...createParams, mode })).toBeNull();
    },
  );

  it.each(INVALID_UUID_PARAMS)(
    'rejects create intent without exactly one valid sectionId %#',
    (sectionId) => {
      expect(parseActivityFormRouteIntent({ ...createParams, sectionId })).toBeNull();
    },
  );

  it.each(['', 'not-a-uuid', ACTIVITY_ID, [ACTIVITY_ID]] as TimelineRouteParam[])(
    'rejects create intent with any activityId %#',
    (activityId) => {
      expect(parseActivityFormRouteIntent({ ...createParams, activityId })).toBeNull();
    },
  );

  it.each(INVALID_UUID_PARAMS)(
    'rejects edit intent without exactly one valid activityId %#',
    (activityId) => {
      expect(parseActivityFormRouteIntent({ ...editParams, activityId })).toBeNull();
    },
  );

  it.each(['', 'not-a-uuid', SECTION_ID, [SECTION_ID]] as TimelineRouteParam[])(
    'rejects edit intent with any sectionId %#',
    (sectionId) => {
      expect(parseActivityFormRouteIntent({ ...editParams, sectionId })).toBeNull();
    },
  );
});
