import {
  ACTIVITY_FIELD_LIMITS,
  MAX_REMINDER_OFFSETS,
  REMINDER_PRESETS,
  applyActivityLocationMode,
  applyActivityTimeMode,
  buildCreateActivityPayload,
  buildCreateSectionPayload,
  buildPatchActivityPayload,
  buildPatchSectionPayload,
  createActivityDraft,
  createSectionDraft,
  getActivityDirtyFields,
  getSectionDirtyFields,
  getSelectableCustomTypes,
  hydrateActivityDraft,
  hydrateSectionDraft,
  toggleActivityReminder,
  validateActivityDraft,
  validateSectionDraft,
  type ActivityFormDraft,
} from '../formModel';
import type {
  TimelineActivity,
  TimelineCustomTypeMeta,
  TimelineSection,
} from '../types';

function buildActivity(
  overrides: Partial<TimelineActivity> = {},
): TimelineActivity {
  return {
    id: 'activity-1',
    title: 'Breakfast',
    time_mode: 'AT_TIME',
    start_time: '08:30:00',
    end_time: null,
    status: 'UPCOMING',
    position: 0,
    activity_type: {
      kind: 'SYSTEM',
      code: 'FOOD',
      label: 'Food',
      color_token: 'amber',
      icon_key: 'restaurant',
    },
    assignee_scope: 'USER',
    assignee: {
      id: 'member-1',
      display_name: 'Minh',
      identify_tag: 'minh',
    },
    location: {
      location_mode: 'STRUCTURED',
      location_label: 'Morning Market',
      location_note: 'Meet at the main gate',
      place: {
        provider: 'here',
        provider_id: 'canonical-place-id',
        title: 'Morning Market',
        address: '1 Market Street',
        lat: 16.01,
        lng: 108.2,
      },
      open_url: 'https://share.here.com/example',
    },
    note: 'Try the local noodles',
    meeting_point: 'Main gate',
    contact_name: 'Lan',
    contact_phone: '0900000000',
    booking_reference: 'BOOK-1',
    external_link: 'https://example.com/booking',
    reminder_offsets_minutes: [1440, 30],
    capabilities: {
      can_edit: true,
      can_delete: true,
      can_update_status: true,
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
    label: 'Arrival day',
    is_label_custom: true,
    is_in_trip_range: true,
    position: 0,
    activities: [],
    ...overrides,
  };
}

function validDraft(
  overrides: Partial<ActivityFormDraft> = {},
): ActivityFormDraft {
  return {
    ...createActivityDraft(),
    title: 'Breakfast',
    start_time: '08:30',
    ...overrides,
  };
}

describe('activity draft hydration and immutable transitions', () => {
  it('provides explicit independent create defaults', () => {
    const first = createActivityDraft();
    const second = createActivityDraft();

    expect(first).toEqual({
      title: '',
      time_mode: 'AT_TIME',
      start_time: '',
      end_time: '',
      system_type: 'OTHER',
      custom_type_id: null,
      assignee_scope: 'NONE',
      assignee_user_id: null,
      location_mode: 'MANUAL',
      location_label: '',
      location_note: '',
      place: null,
      note: '',
      meeting_point: '',
      contact_name: '',
      contact_phone: '',
      booking_reference: '',
      external_link: '',
      reminder_offsets_minutes: [],
    });
    expect(first).not.toBe(second);
    expect(first.reminder_offsets_minutes).not.toBe(
      second.reminder_offsets_minutes,
    );
  });

  it('hydrates a fresh draft without retaining mutable activity references', () => {
    const activity = buildActivity();
    const draft = hydrateActivityDraft(activity);

    expect(draft.start_time).toBe('08:30');
    expect(draft.system_type).toBe('FOOD');
    expect(draft.custom_type_id).toBeNull();
    expect(draft.assignee_user_id).toBe('member-1');
    expect(draft.place).toEqual(activity.location.place);
    expect(draft.place).not.toBe(activity.location.place);
    expect(draft.reminder_offsets_minutes).not.toBe(
      activity.reminder_offsets_minutes,
    );

    if (draft.place) {
      draft.place.title = 'Changed';
    }
    draft.reminder_offsets_minutes.push(15);

    expect(activity.location.place?.title).toBe('Morning Market');
    expect(activity.reminder_offsets_minutes).toEqual([1440, 30]);
  });

  it('does not invent a type when a defensive read has a null activity_type', () => {
    const draft = hydrateActivityDraft(
      buildActivity({ activity_type: null }),
    );

    expect(draft.system_type).toBeNull();
    expect(draft.custom_type_id).toBeNull();
    expect(validateActivityDraft(draft).fieldErrors.activity_type).toBeDefined();
  });

  it('clears incompatible time and location values immutably', () => {
    const draft = validDraft({
      end_time: '09:30',
      reminder_offsets_minutes: [30],
      location_mode: 'STRUCTURED',
      place: {
        provider: 'here',
        provider_id: 'canonical',
        title: 'Cafe',
        address: '',
        lat: null,
        lng: null,
      },
    });

    const allDay = applyActivityTimeMode(draft, 'ALL_DAY');
    const manual = applyActivityLocationMode(draft, 'MANUAL');

    expect(allDay).toMatchObject({
      time_mode: 'ALL_DAY',
      start_time: '',
      end_time: '',
      reminder_offsets_minutes: [],
    });
    expect(manual.location_mode).toBe('MANUAL');
    expect(manual.place).toBeNull();
    expect(draft.start_time).toBe('08:30');
    expect(draft.place).not.toBeNull();
  });
});

describe('activity time and reminder validation', () => {
  it.each([
    [
      validDraft({ time_mode: 'AT_TIME', start_time: '' }),
      'start_time',
    ],
    [
      validDraft({ time_mode: 'AT_TIME', end_time: '09:00' }),
      'end_time',
    ],
    [
      validDraft({
        time_mode: 'TIME_RANGE',
        start_time: '08:30',
        end_time: '',
      }),
      'end_time',
    ],
    [
      validDraft({
        time_mode: 'TIME_RANGE',
        start_time: '08:30',
        end_time: '08:30',
      }),
      'end_time',
    ],
    [
      validDraft({
        time_mode: 'ALL_DAY',
        start_time: '08:30',
      }),
      'time_mode',
    ],
    [
      validDraft({
        time_mode: 'FLEXIBLE',
        start_time: '',
        reminder_offsets_minutes: [30],
      }),
      'reminder_offsets_minutes',
    ],
  ])('rejects invalid time-mode combinations', (draft, errorField) => {
    expect(validateActivityDraft(draft).fieldErrors).toHaveProperty(errorField);
  });

  it('accepts strict increasing ranges and all-day drafts without times', () => {
    expect(
      validateActivityDraft(
        validDraft({
          time_mode: 'TIME_RANGE',
          end_time: '08:31',
        }),
      ).isValid,
    ).toBe(true);
    expect(
      validateActivityDraft(
        validDraft({
          time_mode: 'ALL_DAY',
          start_time: '',
        }),
      ).isValid,
    ).toBe(true);
  });

  it.each([
    [[30, 30], 'duplicate'],
    [[60], 'unsupported'],
    [
      [10080, 1440, 120, 30, 15, 15],
      'over maximum',
    ],
  ])('rejects %s reminder sets', (reminders) => {
    const result = validateActivityDraft(
      validDraft({ reminder_offsets_minutes: reminders }),
    );
    expect(result.fieldErrors.reminder_offsets_minutes).toBeDefined();
  });

  it('exports the exact five server presets and enforces the toggle limit', () => {
    expect(REMINDER_PRESETS.map((preset) => preset.value)).toEqual([
      10080, 1440, 120, 30, 15,
    ]);
    expect(MAX_REMINDER_OFFSETS).toBe(5);

    let draft = validDraft();
    for (const preset of [...REMINDER_PRESETS].reverse()) {
      draft = toggleActivityReminder(draft, preset.value);
    }

    expect(draft.reminder_offsets_minutes).toEqual([
      10080, 1440, 120, 30, 15,
    ]);
    expect(toggleActivityReminder(draft, 60)).toBe(draft);
  });
});

describe('activity type, assignee, and location validation', () => {
  it('requires exactly one system or custom activity type', () => {
    const neither = validDraft({
      system_type: null,
      custom_type_id: null,
    });
    const both = validDraft({
      system_type: 'FOOD',
      custom_type_id: 'custom-1',
    });
    const custom = validDraft({
      system_type: null,
      custom_type_id: 'custom-1',
    });

    expect(
      validateActivityDraft(neither).fieldErrors.activity_type,
    ).toBeDefined();
    expect(
      validateActivityDraft(both).fieldErrors.activity_type,
    ).toBeDefined();
    expect(validateActivityDraft(custom).isValid).toBe(true);
  });

  it('requires USER to reference an active member and forbids ids for other scopes', () => {
    const missing = validDraft({
      assignee_scope: 'USER',
      assignee_user_id: null,
    });
    const inactive = validDraft({
      assignee_scope: 'USER',
      assignee_user_id: 'member-2',
    });
    const active = validDraft({
      assignee_scope: 'USER',
      assignee_user_id: 'member-1',
    });
    const noneWithId = validDraft({
      assignee_scope: 'NONE',
      assignee_user_id: 'member-1',
    });

    expect(
      validateActivityDraft(missing).fieldErrors.assignee_user_id,
    ).toBeDefined();
    expect(
      validateActivityDraft(inactive, {
        activeAssigneeIds: ['member-1'],
      }).fieldErrors.assignee_user_id,
    ).toBeDefined();
    expect(
      validateActivityDraft(active, {
        activeAssigneeIds: new Set(['member-1']),
      }).isValid,
    ).toBe(true);
    expect(
      validateActivityDraft(noneWithId).fieldErrors.assignee_user_id,
    ).toBeDefined();
  });

  it('enforces MANUAL null-place and STRUCTURED required-place rules', () => {
    const place = {
      provider: 'here',
      provider_id: 'canonical-id',
      title: 'Cafe',
      address: 'Da Nang',
      lat: 16,
      lng: 108,
    };

    expect(
      validateActivityDraft(
        validDraft({ location_mode: 'MANUAL', place }),
      ).fieldErrors.place,
    ).toBeDefined();
    expect(
      validateActivityDraft(
        validDraft({ location_mode: 'STRUCTURED', place: null }),
      ).fieldErrors.place,
    ).toBeDefined();
    expect(
      validateActivityDraft(
        validDraft({ location_mode: 'STRUCTURED', place }),
      ).isValid,
    ).toBe(true);
  });

  it('keeps the inactive current custom type selectable only for edit hydration', () => {
    const customTypes: TimelineCustomTypeMeta[] = [
      {
        id: 'active',
        name: 'Active',
        normalized_name: 'active',
        color_token: 'slate',
        icon_key: 'tag',
        is_active: true,
      },
      {
        id: 'inactive-current',
        name: 'Inactive current',
        normalized_name: 'inactive-current',
        color_token: 'slate',
        icon_key: 'tag',
        is_active: false,
      },
      {
        id: 'inactive-other',
        name: 'Inactive other',
        normalized_name: 'inactive-other',
        color_token: 'slate',
        icon_key: 'tag',
        is_active: false,
      },
    ];
    const initial = buildActivity({
      activity_type: {
        kind: 'CUSTOM',
        id: 'inactive-current',
        label: 'Inactive current',
        color_token: 'slate',
        icon_key: 'tag',
      },
    });

    expect(
      getSelectableCustomTypes(customTypes, initial).map((type) => type.id),
    ).toEqual(['active', 'inactive-current']);
    expect(getSelectableCustomTypes(customTypes).map((type) => type.id)).toEqual([
      'active',
    ]);
  });
});

describe('activity field caps', () => {
  it('counts Unicode code points and enforces title boundaries', () => {
    expect(
      validateActivityDraft(
        validDraft({ title: '😀'.repeat(ACTIVITY_FIELD_LIMITS.title) }),
      ).isValid,
    ).toBe(true);
    expect(
      validateActivityDraft(
        validDraft({ title: '😀'.repeat(ACTIVITY_FIELD_LIMITS.title + 1) }),
      ).fieldErrors.title,
    ).toBeDefined();
  });

  it.each([
    ['location_label', ACTIVITY_FIELD_LIMITS.location_label],
    ['location_note', ACTIVITY_FIELD_LIMITS.location_note],
    ['meeting_point', ACTIVITY_FIELD_LIMITS.meeting_point],
    ['contact_name', ACTIVITY_FIELD_LIMITS.contact_name],
    ['contact_phone', ACTIVITY_FIELD_LIMITS.contact_phone],
    ['booking_reference', ACTIVITY_FIELD_LIMITS.booking_reference],
    ['external_link', ACTIVITY_FIELD_LIMITS.external_link],
  ] as const)('enforces the %s cap', (field, limit) => {
    const result = validateActivityDraft(
      validDraft({ [field]: 'x'.repeat(limit + 1) }),
    );
    expect(result.fieldErrors).toHaveProperty(field);
  });

  it.each([
    ['provider', ACTIVITY_FIELD_LIMITS.place_provider, 'place.provider'],
    [
      'provider_id',
      ACTIVITY_FIELD_LIMITS.place_provider_id,
      'place.provider_id',
    ],
    ['title', ACTIVITY_FIELD_LIMITS.place_title, 'place.title'],
    ['address', ACTIVITY_FIELD_LIMITS.place_address, 'place.address'],
  ] as const)('enforces the structured place %s cap', (field, limit, errorKey) => {
    const result = validateActivityDraft(
      validDraft({
        location_mode: 'STRUCTURED',
        place: {
          provider: 'here',
          provider_id: 'canonical',
          title: 'Cafe',
          address: '',
          lat: null,
          lng: null,
          [field]: 'x'.repeat(limit + 1),
        },
      }),
    );

    expect(result.fieldErrors[errorKey]).toBeDefined();
  });

  it('rejects malformed external links within the cap', () => {
    expect(
      validateActivityDraft(
        validDraft({ external_link: 'not a URL' }),
      ).fieldErrors.external_link,
    ).toBeDefined();
  });
});

describe('activity payloads', () => {
  it('builds a complete normalized create payload', () => {
    const payload = buildCreateActivityPayload(
      validDraft({
        title: '  Dinner  ',
        time_mode: 'TIME_RANGE',
        start_time: '18:00',
        end_time: '20:00',
        system_type: null,
        custom_type_id: 'custom-food',
        assignee_scope: 'USER',
        assignee_user_id: 'member-1',
        location_mode: 'STRUCTURED',
        location_label: '  Riverside  ',
        location_note: '  Meet outside  ',
        place: {
          provider: ' here ',
          provider_id: 'canonical-id',
          title: ' Riverside ',
          address: ' River Road ',
          lat: 16,
          lng: 108,
        },
        note: '  Bring cash  ',
        meeting_point: '  Entrance  ',
        contact_name: '  Lan  ',
        contact_phone: '  0900  ',
        booking_reference: '  REF-1  ',
        external_link: '  https://example.com/dinner  ',
        reminder_offsets_minutes: [15, 1440, 30],
      }),
      { activeAssigneeIds: ['member-1'] },
    );

    expect(payload).toEqual({
      title: 'Dinner',
      time_mode: 'TIME_RANGE',
      start_time: '18:00',
      end_time: '20:00',
      system_type: '',
      custom_type_id: 'custom-food',
      assignee_scope: 'USER',
      assignee_user_id: 'member-1',
      location_mode: 'STRUCTURED',
      location_label: 'Riverside',
      location_note: 'Meet outside',
      place: {
        provider: 'here',
        provider_id: 'canonical-id',
        title: 'Riverside',
        address: 'River Road',
        lat: 16,
        lng: 108,
      },
      note: 'Bring cash',
      meeting_point: 'Entrance',
      contact_name: 'Lan',
      contact_phone: '0900',
      booking_reference: 'REF-1',
      external_link: 'https://example.com/dinner',
      reminder_offsets_minutes: [1440, 30, 15],
    });
  });

  it('serializes non-timed values with explicit null times and no reminders', () => {
    const payload = buildCreateActivityPayload(
      validDraft({
        time_mode: 'ALL_DAY',
        start_time: '',
      }),
    );

    expect(payload).toMatchObject({
      time_mode: 'ALL_DAY',
      start_time: null,
      end_time: null,
      reminder_offsets_minutes: [],
    });
  });

  it('returns null instead of producing an invalid payload', () => {
    expect(buildCreateActivityPayload(createActivityDraft())).toBeNull();
  });

  it('builds a dirty-field minimal title PATCH', () => {
    const initial = hydrateActivityDraft(buildActivity());
    const draft = { ...initial, title: 'Brunch', note: 'Changed but untouched' };

    expect(
      buildPatchActivityPayload(initial, draft, { title: true }),
    ).toEqual({ title: 'Brunch' });
  });

  it('omits fields changed back to their normalized initial value', () => {
    const initial = validDraft({ title: 'Breakfast' });
    const draft = { ...initial, title: ' Breakfast ' };

    expect(getActivityDirtyFields(initial, draft)).toEqual({ title: true });
    expect(buildPatchActivityPayload(initial, draft)).toEqual({});
  });

  it('sends both xor fields when switching activity type', () => {
    const initial = validDraft({ system_type: 'FOOD' });
    const draft = {
      ...initial,
      system_type: null,
      custom_type_id: 'custom-food',
    };

    expect(buildPatchActivityPayload(initial, draft)).toEqual({
      system_type: '',
      custom_type_id: 'custom-food',
    });
  });

  it('sends linked time fields that actually change with a mode transition', () => {
    const initial = validDraft({
      start_time: '08:30',
      reminder_offsets_minutes: [30],
    });
    const draft = applyActivityTimeMode(initial, 'FLEXIBLE');

    expect(buildPatchActivityPayload(initial, draft)).toEqual({
      time_mode: 'FLEXIBLE',
      start_time: null,
      reminder_offsets_minutes: [],
    });
  });

  it('clears canonical place only on an explicit dirty switch to MANUAL', () => {
    const initial = hydrateActivityDraft(buildActivity());
    const draft = applyActivityLocationMode(initial, 'MANUAL');

    expect(buildPatchActivityPayload(initial, draft)).toEqual({
      location_mode: 'MANUAL',
      place: null,
    });
  });
});

describe('section form model', () => {
  it('creates and hydrates independent section drafts', () => {
    expect(createSectionDraft('2026-06-01')).toEqual({
      section_date: '2026-06-01',
      label: '',
    });
    expect(hydrateSectionDraft(buildSection())).toEqual({
      section_date: '2026-06-01',
      label: 'Arrival day',
    });
  });

  it.each([
    [{ section_date: '', label: 'Day' }, 'section_date'],
    [{ section_date: '2026-02-30', label: 'Day' }, 'section_date'],
    [{ section_date: '2026-06-01', label: '   ' }, 'label'],
    [
      { section_date: '2026-06-01', label: 'x'.repeat(121) },
      'label',
    ],
  ])('validates date and label rules', (draft, errorField) => {
    expect(validateSectionDraft(draft).fieldErrors).toHaveProperty(errorField);
  });

  it('builds a trimmed create payload', () => {
    expect(
      buildCreateSectionPayload({
        section_date: '2026-06-01',
        label: '  Arrival day  ',
      }),
    ).toEqual({
      section_date: '2026-06-01',
      label: 'Arrival day',
    });
  });

  it('builds only the explicitly dirty changed section fields', () => {
    const initial = hydrateSectionDraft(buildSection());
    const draft = {
      section_date: '2026-06-02',
      label: 'Departure day',
    };

    expect(getSectionDirtyFields(initial, draft)).toEqual({
      section_date: true,
      label: true,
    });
    expect(
      buildPatchSectionPayload(initial, draft, { label: true }),
    ).toEqual({
      label: 'Departure day',
    });
  });

  it('returns null for invalid section payloads and an empty patch for no change', () => {
    const initial = hydrateSectionDraft(buildSection());
    expect(buildCreateSectionPayload(createSectionDraft())).toBeNull();
    expect(buildPatchSectionPayload(initial, initial)).toEqual({});
  });
});
