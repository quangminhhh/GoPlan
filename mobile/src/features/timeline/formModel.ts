import type {
  ActivityPlacePayload,
  CreateActivityPayload,
  CreateSectionPayload,
  PatchActivityPayload,
  PatchSectionPayload,
  TimelineActivity,
  TimelineActivityAssigneeScope,
  TimelineActivityTimeMode,
  TimelineCustomTypeMeta,
  TimelineLocationMode,
  TimelineSection,
  TimelineSystemTypeCode,
} from './types';

export const REMINDER_PRESETS = [
  { value: 10080, label: '7 days' },
  { value: 1440, label: '1 day' },
  { value: 120, label: '2 h' },
  { value: 30, label: '30 min' },
  { value: 15, label: '15 min' },
] as const;

export const MAX_REMINDER_OFFSETS = 5;
const ACTIVITY_COORDINATE_DECIMAL_PLACES = 6;

export const ACTIVITY_FIELD_LIMITS = {
  title: 140,
  location_label: 200,
  location_note: 200,
  place_provider: 16,
  place_provider_id: 255,
  place_title: 200,
  place_address: 255,
  meeting_point: 200,
  contact_name: 120,
  contact_phone: 32,
  booking_reference: 120,
  external_link: 500,
} as const;

export const SECTION_FIELD_LIMITS = {
  label: 120,
} as const;

const SYSTEM_TYPE_CODES = new Set<string>([
  'TRANSPORTATION',
  'ACCOMMODATION',
  'FOOD',
  'SIGHTSEEING',
  'SHOPPING',
  'CHECKIN_OUT',
  'FREE_TIME',
  'OTHER',
] satisfies TimelineSystemTypeCode[]);

const REMINDER_VALUES = new Set<number>(
  REMINDER_PRESETS.map((preset) => preset.value),
);

const ACTIVITY_DRAFT_FIELDS = [
  'title',
  'time_mode',
  'start_time',
  'end_time',
  'system_type',
  'custom_type_id',
  'assignee_scope',
  'assignee_user_id',
  'location_mode',
  'location_label',
  'location_note',
  'place',
  'note',
  'meeting_point',
  'contact_name',
  'contact_phone',
  'booking_reference',
  'external_link',
  'reminder_offsets_minutes',
] as const;

const SECTION_DRAFT_FIELDS = ['section_date', 'label'] as const;

export interface ActivityFormDraft {
  title: string;
  time_mode: TimelineActivityTimeMode;
  start_time: string;
  end_time: string;
  system_type: TimelineSystemTypeCode | null;
  custom_type_id: string | null;
  assignee_scope: TimelineActivityAssigneeScope;
  assignee_user_id: string | null;
  location_mode: TimelineLocationMode;
  location_label: string;
  location_note: string;
  place: ActivityPlacePayload | null;
  note: string;
  meeting_point: string;
  contact_name: string;
  contact_phone: string;
  booking_reference: string;
  external_link: string;
  reminder_offsets_minutes: number[];
}

export interface SectionFormDraft {
  section_date: string;
  label: string;
}

export type ActivityDraftField = (typeof ACTIVITY_DRAFT_FIELDS)[number];
export type SectionDraftField = (typeof SECTION_DRAFT_FIELDS)[number];

export type ActivityFormDirtyFields = Readonly<
  Partial<Record<ActivityDraftField, boolean>>
>;
export type SectionFormDirtyFields = Readonly<
  Partial<Record<SectionDraftField, boolean>>
>;

export type ActivityFormErrorField =
  | ActivityDraftField
  | 'activity_type'
  | 'place.provider'
  | 'place.provider_id'
  | 'place.title'
  | 'place.address'
  | 'place.lat'
  | 'place.lng';

export type ActivityFormFieldErrors = Partial<
  Record<ActivityFormErrorField, string>
>;
export type SectionFormFieldErrors = Partial<
  Record<SectionDraftField, string>
>;

export interface ActivityValidationOptions {
  activeAssigneeIds?: ReadonlySet<string> | readonly string[];
  selectableCustomTypeIds?: ReadonlySet<string> | readonly string[];
}

export interface FormValidationResult<TField extends string> {
  isValid: boolean;
  fieldErrors: Partial<Record<TField, string>>;
}

export function createActivityDraft(): ActivityFormDraft {
  return {
    title: '',
    time_mode: 'AT_TIME',
    start_time: '00:00',
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
  };
}

export function hydrateActivityDraft(
  activity: TimelineActivity,
): ActivityFormDraft {
  const systemType =
    activity.activity_type?.kind === 'SYSTEM'
      ? activity.activity_type.code
      : null;
  const customTypeId =
    activity.activity_type?.kind === 'CUSTOM'
      ? activity.activity_type.id
      : null;

  return {
    title: activity.title,
    time_mode: activity.time_mode,
    start_time: activity.start_time?.slice(0, 5) ?? '',
    end_time: activity.end_time?.slice(0, 5) ?? '',
    system_type: systemType,
    custom_type_id: customTypeId,
    assignee_scope: activity.assignee_scope,
    assignee_user_id:
      activity.assignee_scope === 'USER' ? activity.assignee?.id ?? null : null,
    location_mode: activity.location.location_mode,
    location_label: activity.location.location_label,
    location_note: activity.location.location_note,
    place: clonePlace(activity.location.place),
    note: activity.note,
    meeting_point: activity.meeting_point,
    contact_name: activity.contact_name,
    contact_phone: activity.contact_phone,
    booking_reference: activity.booking_reference,
    external_link: activity.external_link,
    reminder_offsets_minutes: [...activity.reminder_offsets_minutes],
  };
}

export function cloneActivityDraft(
  draft: ActivityFormDraft,
): ActivityFormDraft {
  return {
    ...draft,
    place: clonePlace(draft.place),
    reminder_offsets_minutes: [...draft.reminder_offsets_minutes],
  };
}

export function applyActivityTimeMode(
  draft: ActivityFormDraft,
  timeMode: TimelineActivityTimeMode,
): ActivityFormDraft {
  const next = cloneActivityDraft(draft);
  next.time_mode = timeMode;

  if (timeMode === 'AT_TIME') {
    if (!isValidTime(next.start_time)) {
      next.start_time = '00:00';
    }
    next.end_time = '';
  } else if (timeMode === 'TIME_RANGE') {
    if (!isValidTime(next.start_time)) {
      next.start_time = '00:00';
    }
    if (!isValidTime(next.end_time)) {
      next.end_time = defaultRangeEndTime(next.start_time);
    }
  } else if (timeMode === 'ALL_DAY' || timeMode === 'FLEXIBLE') {
    next.start_time = '';
    next.end_time = '';
    next.reminder_offsets_minutes = [];
  }

  return next;
}

export function applyActivityLocationMode(
  draft: ActivityFormDraft,
  locationMode: TimelineLocationMode,
): ActivityFormDraft {
  const next = cloneActivityDraft(draft);
  next.location_mode = locationMode;
  if (locationMode === 'MANUAL') {
    next.place = null;
  }
  return next;
}

export function toggleActivityReminder(
  draft: ActivityFormDraft,
  reminderOffset: number,
): ActivityFormDraft {
  if (
    !REMINDER_VALUES.has(reminderOffset) ||
    !isTimedMode(draft.time_mode) ||
    !isValidTime(draft.start_time)
  ) {
    return draft;
  }

  const reminders = new Set(draft.reminder_offsets_minutes);
  if (reminders.has(reminderOffset)) {
    reminders.delete(reminderOffset);
  } else if (reminders.size < MAX_REMINDER_OFFSETS) {
    reminders.add(reminderOffset);
  } else {
    return draft;
  }

  return {
    ...draft,
    place: clonePlace(draft.place),
    reminder_offsets_minutes: [...reminders].sort((left, right) => right - left),
  };
}

export function getSelectableCustomTypes(
  customTypes: readonly TimelineCustomTypeMeta[],
  initialActivity?: TimelineActivity,
): TimelineCustomTypeMeta[] {
  const initialCustomTypeId =
    initialActivity?.activity_type?.kind === 'CUSTOM'
      ? initialActivity.activity_type.id
      : null;

  return customTypes.filter(
    (customType) =>
      customType.is_active || customType.id === initialCustomTypeId,
  );
}

export function validateActivityDraft(
  draft: ActivityFormDraft,
  options: ActivityValidationOptions = {},
): FormValidationResult<ActivityFormErrorField> {
  const fieldErrors: ActivityFormFieldErrors = {};
  const normalizedTitle = normalizeText(draft.title);

  if (!normalizedTitle) {
    addError(fieldErrors, 'title', 'Title is required.');
  } else if (
    codePointLength(normalizedTitle) > ACTIVITY_FIELD_LIMITS.title
  ) {
    addError(
      fieldErrors,
      'title',
      `Title must be ${ACTIVITY_FIELD_LIMITS.title} characters or fewer.`,
    );
  }

  validateTimeFields(draft, fieldErrors);
  validateActivityType(draft, options, fieldErrors);
  validateAssignee(draft, options, fieldErrors);
  validateLocation(draft, fieldErrors);
  validateActivityTextFields(draft, fieldErrors);
  validateReminders(draft, fieldErrors);

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function buildCreateActivityPayload(
  draft: ActivityFormDraft,
  options: ActivityValidationOptions = {},
): CreateActivityPayload | null {
  if (!validateActivityDraft(draft, options).isValid) {
    return null;
  }
  return serializeActivityDraft(draft);
}

export function getActivityDirtyFields(
  initialDraft: ActivityFormDraft,
  draft: ActivityFormDraft,
): ActivityFormDirtyFields {
  const dirtyFields: Partial<Record<ActivityDraftField, boolean>> = {};
  for (const field of ACTIVITY_DRAFT_FIELDS) {
    if (!valuesEqual(initialDraft[field], draft[field])) {
      dirtyFields[field] = true;
    }
  }
  return dirtyFields;
}

export function buildPatchActivityPayload(
  initialDraft: ActivityFormDraft,
  draft: ActivityFormDraft,
  dirtyFields: ActivityFormDirtyFields = getActivityDirtyFields(
    initialDraft,
    draft,
  ),
  options: ActivityValidationOptions = {},
): PatchActivityPayload | null {
  if (!validateActivityDraft(draft, options).isValid) {
    return null;
  }

  const initialPayload = serializeActivityDraft(initialDraft);
  const currentPayload = serializeActivityDraft(draft);
  const patch: PatchActivityPayload = {};

  if (dirtyFields.title) {
    assignChanged(patch, initialPayload, currentPayload, 'title');
  }

  if (dirtyFields.time_mode) {
    assignChanged(patch, initialPayload, currentPayload, 'time_mode');
  }
  if (dirtyFields.time_mode || dirtyFields.start_time) {
    assignChanged(patch, initialPayload, currentPayload, 'start_time');
  }
  if (dirtyFields.time_mode || dirtyFields.end_time) {
    assignChanged(patch, initialPayload, currentPayload, 'end_time');
  }
  if (
    dirtyFields.time_mode ||
    dirtyFields.start_time ||
    dirtyFields.reminder_offsets_minutes
  ) {
    assignChanged(
      patch,
      initialPayload,
      currentPayload,
      'reminder_offsets_minutes',
    );
  }

  if (dirtyFields.system_type || dirtyFields.custom_type_id) {
    assignChanged(patch, initialPayload, currentPayload, 'system_type');
    assignChanged(patch, initialPayload, currentPayload, 'custom_type_id');
  }

  if (dirtyFields.assignee_scope || dirtyFields.assignee_user_id) {
    assignChanged(patch, initialPayload, currentPayload, 'assignee_scope');
    assignChanged(patch, initialPayload, currentPayload, 'assignee_user_id');
  }

  if (dirtyFields.location_mode || dirtyFields.place) {
    assignChanged(patch, initialPayload, currentPayload, 'location_mode');
    assignChanged(patch, initialPayload, currentPayload, 'place');
  }
  if (dirtyFields.location_label) {
    assignChanged(patch, initialPayload, currentPayload, 'location_label');
  }
  if (dirtyFields.location_note) {
    assignChanged(patch, initialPayload, currentPayload, 'location_note');
  }

  assignDirectDraftField(
    patch,
    initialPayload,
    currentPayload,
    dirtyFields,
    'note',
  );
  assignDirectDraftField(
    patch,
    initialPayload,
    currentPayload,
    dirtyFields,
    'meeting_point',
  );
  assignDirectDraftField(
    patch,
    initialPayload,
    currentPayload,
    dirtyFields,
    'contact_name',
  );
  assignDirectDraftField(
    patch,
    initialPayload,
    currentPayload,
    dirtyFields,
    'contact_phone',
  );
  assignDirectDraftField(
    patch,
    initialPayload,
    currentPayload,
    dirtyFields,
    'booking_reference',
  );
  assignDirectDraftField(
    patch,
    initialPayload,
    currentPayload,
    dirtyFields,
    'external_link',
  );

  return patch;
}

export function createSectionDraft(sectionDate = ''): SectionFormDraft {
  return {
    section_date: sectionDate,
    label: '',
  };
}

export function hydrateSectionDraft(section: TimelineSection): SectionFormDraft {
  return {
    section_date: section.section_date,
    label: section.label,
  };
}

export function validateSectionDraft(
  draft: SectionFormDraft,
): FormValidationResult<SectionDraftField> {
  const fieldErrors: SectionFormFieldErrors = {};
  const label = normalizeText(draft.label);

  if (!isValidIsoDate(draft.section_date)) {
    addError(fieldErrors, 'section_date', 'Enter a valid date.');
  }
  if (!label) {
    addError(fieldErrors, 'label', 'Label is required.');
  } else if (codePointLength(label) > SECTION_FIELD_LIMITS.label) {
    addError(
      fieldErrors,
      'label',
      `Label must be ${SECTION_FIELD_LIMITS.label} characters or fewer.`,
    );
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function buildCreateSectionPayload(
  draft: SectionFormDraft,
): CreateSectionPayload | null {
  if (!validateSectionDraft(draft).isValid) {
    return null;
  }
  return serializeSectionDraft(draft);
}

export function getSectionDirtyFields(
  initialDraft: SectionFormDraft,
  draft: SectionFormDraft,
): SectionFormDirtyFields {
  const dirtyFields: Partial<Record<SectionDraftField, boolean>> = {};
  for (const field of SECTION_DRAFT_FIELDS) {
    if (initialDraft[field] !== draft[field]) {
      dirtyFields[field] = true;
    }
  }
  return dirtyFields;
}

export function buildPatchSectionPayload(
  initialDraft: SectionFormDraft,
  draft: SectionFormDraft,
  dirtyFields: SectionFormDirtyFields = getSectionDirtyFields(
    initialDraft,
    draft,
  ),
): PatchSectionPayload | null {
  if (!validateSectionDraft(draft).isValid) {
    return null;
  }

  const initialPayload = serializeSectionDraft(initialDraft);
  const currentPayload = serializeSectionDraft(draft);
  const patch: PatchSectionPayload = {};

  if (
    dirtyFields.section_date &&
    initialPayload.section_date !== currentPayload.section_date
  ) {
    patch.section_date = currentPayload.section_date;
  }
  if (dirtyFields.label && initialPayload.label !== currentPayload.label) {
    patch.label = currentPayload.label;
  }
  return patch;
}

function validateTimeFields(
  draft: ActivityFormDraft,
  fieldErrors: ActivityFormFieldErrors,
): void {
  if (draft.time_mode === 'ALL_DAY' || draft.time_mode === 'FLEXIBLE') {
    if (draft.start_time || draft.end_time) {
      addError(
        fieldErrors,
        'time_mode',
        `${draft.time_mode === 'ALL_DAY' ? 'All-day' : 'Flexible'} activities cannot have times.`,
      );
    }
    return;
  }

  if (!isValidTime(draft.start_time)) {
    addError(fieldErrors, 'start_time', 'Enter a valid start time.');
  }

  if (draft.time_mode === 'AT_TIME') {
    if (draft.end_time) {
      addError(
        fieldErrors,
        'end_time',
        'At-time activities cannot have an end time.',
      );
    }
    return;
  }

  if (!isValidTime(draft.end_time)) {
    addError(fieldErrors, 'end_time', 'Enter a valid end time.');
    return;
  }

  if (
    isValidTime(draft.start_time) &&
    timeToMinutes(draft.end_time) <= timeToMinutes(draft.start_time)
  ) {
    addError(fieldErrors, 'end_time', 'End time must be after start time.');
  }
}

function validateActivityType(
  draft: ActivityFormDraft,
  options: ActivityValidationOptions,
  fieldErrors: ActivityFormFieldErrors,
): void {
  const hasSystem = draft.system_type !== null;
  const hasCustom =
    draft.custom_type_id !== null &&
    normalizeText(draft.custom_type_id).length > 0;

  if (hasSystem === hasCustom) {
    addError(
      fieldErrors,
      'activity_type',
      'Choose exactly one activity type.',
    );
    return;
  }

  if (hasSystem && !SYSTEM_TYPE_CODES.has(draft.system_type ?? '')) {
    addError(fieldErrors, 'activity_type', 'Choose a valid activity type.');
    return;
  }

  if (
    hasCustom &&
    options.selectableCustomTypeIds &&
    !containsId(
      options.selectableCustomTypeIds,
      normalizeText(draft.custom_type_id ?? ''),
    )
  ) {
    addError(
      fieldErrors,
      'activity_type',
      'The selected custom type is no longer available. Choose another activity type.',
    );
  }
}

function validateAssignee(
  draft: ActivityFormDraft,
  options: ActivityValidationOptions,
  fieldErrors: ActivityFormFieldErrors,
): void {
  if (draft.assignee_scope === 'USER') {
    const assigneeId = normalizeText(draft.assignee_user_id ?? '');
    if (!assigneeId) {
      addError(
        fieldErrors,
        'assignee_user_id',
        'Choose an active trip member.',
      );
      return;
    }

    const activeIds = options.activeAssigneeIds;
    if (activeIds && !containsId(activeIds, assigneeId)) {
      addError(
        fieldErrors,
        'assignee_user_id',
        'Choose an active trip member.',
      );
    }
    return;
  }

  if (draft.assignee_user_id !== null) {
    addError(
      fieldErrors,
      'assignee_user_id',
      'An individual assignee is only allowed for the User scope.',
    );
  }
}

function validateLocation(
  draft: ActivityFormDraft,
  fieldErrors: ActivityFormFieldErrors,
): void {
  if (
    codePointLength(normalizeText(draft.location_label)) >
    ACTIVITY_FIELD_LIMITS.location_label
  ) {
    addError(
      fieldErrors,
      'location_label',
      `Location label must be ${ACTIVITY_FIELD_LIMITS.location_label} characters or fewer.`,
    );
  }
  if (
    codePointLength(normalizeText(draft.location_note)) >
    ACTIVITY_FIELD_LIMITS.location_note
  ) {
    addError(
      fieldErrors,
      'location_note',
      `Location note must be ${ACTIVITY_FIELD_LIMITS.location_note} characters or fewer.`,
    );
  }

  if (draft.location_mode === 'MANUAL') {
    if (draft.place !== null) {
      addError(
        fieldErrors,
        'place',
        'Manual locations cannot include structured place data.',
      );
    }
    return;
  }

  if (draft.place === null) {
    addError(
      fieldErrors,
      'place',
      'Choose a verified place for a structured location.',
    );
    return;
  }

  validatePlace(draft.place, fieldErrors);
}

function validatePlace(
  place: ActivityPlacePayload,
  fieldErrors: ActivityFormFieldErrors,
): void {
  validateRequiredCappedText(
    place.provider,
    ACTIVITY_FIELD_LIMITS.place_provider,
    'place.provider',
    'Provider',
    fieldErrors,
  );
  validateRequiredCappedText(
    place.provider_id,
    ACTIVITY_FIELD_LIMITS.place_provider_id,
    'place.provider_id',
    'Provider id',
    fieldErrors,
  );
  validateRequiredCappedText(
    place.title,
    ACTIVITY_FIELD_LIMITS.place_title,
    'place.title',
    'Place title',
    fieldErrors,
  );

  if (
    codePointLength(normalizeText(place.address ?? '')) >
    ACTIVITY_FIELD_LIMITS.place_address
  ) {
    addError(
      fieldErrors,
      'place.address',
      `Place address must be ${ACTIVITY_FIELD_LIMITS.place_address} characters or fewer.`,
    );
  }

  if (place.lat !== null && place.lat !== undefined && !Number.isFinite(place.lat)) {
    addError(fieldErrors, 'place.lat', 'Latitude must be a finite number.');
  }
  if (place.lng !== null && place.lng !== undefined && !Number.isFinite(place.lng)) {
    addError(fieldErrors, 'place.lng', 'Longitude must be a finite number.');
  }
}

function validateActivityTextFields(
  draft: ActivityFormDraft,
  fieldErrors: ActivityFormFieldErrors,
): void {
  validateOptionalCappedText(
    draft.meeting_point,
    ACTIVITY_FIELD_LIMITS.meeting_point,
    'meeting_point',
    'Meeting point',
    fieldErrors,
  );
  validateOptionalCappedText(
    draft.contact_name,
    ACTIVITY_FIELD_LIMITS.contact_name,
    'contact_name',
    'Contact name',
    fieldErrors,
  );
  validateOptionalCappedText(
    draft.contact_phone,
    ACTIVITY_FIELD_LIMITS.contact_phone,
    'contact_phone',
    'Contact phone',
    fieldErrors,
  );
  validateOptionalCappedText(
    draft.booking_reference,
    ACTIVITY_FIELD_LIMITS.booking_reference,
    'booking_reference',
    'Booking reference',
    fieldErrors,
  );
  validateOptionalCappedText(
    draft.external_link,
    ACTIVITY_FIELD_LIMITS.external_link,
    'external_link',
    'External link',
    fieldErrors,
  );

  const externalLink = normalizeText(draft.external_link);
  if (externalLink && !isValidExternalUrl(externalLink)) {
    addError(fieldErrors, 'external_link', 'Enter a valid URL.');
  }
}

function validateReminders(
  draft: ActivityFormDraft,
  fieldErrors: ActivityFormFieldErrors,
): void {
  const reminders = draft.reminder_offsets_minutes;
  if (!Array.isArray(reminders)) {
    addError(fieldErrors, 'reminder_offsets_minutes', 'Invalid reminders.');
    return;
  }
  if (reminders.length > MAX_REMINDER_OFFSETS) {
    addError(
      fieldErrors,
      'reminder_offsets_minutes',
      `Choose at most ${MAX_REMINDER_OFFSETS} reminders.`,
    );
    return;
  }

  const uniqueReminders = new Set<number>();
  for (const reminder of reminders) {
    if (
      !Number.isInteger(reminder) ||
      !REMINDER_VALUES.has(reminder) ||
      uniqueReminders.has(reminder)
    ) {
      addError(
        fieldErrors,
        'reminder_offsets_minutes',
        'Use each supported reminder preset at most once.',
      );
      return;
    }
    uniqueReminders.add(reminder);
  }

  if (!isTimedMode(draft.time_mode) && reminders.length > 0) {
    addError(
      fieldErrors,
      'reminder_offsets_minutes',
      'All-day and flexible activities cannot have reminders.',
    );
  } else if (
    reminders.length > 0 &&
    !isValidTime(draft.start_time)
  ) {
    addError(
      fieldErrors,
      'reminder_offsets_minutes',
      'Set a valid start time before adding reminders.',
    );
  }
}

function serializeActivityDraft(
  draft: ActivityFormDraft,
): CreateActivityPayload {
  const timed = isTimedMode(draft.time_mode);
  const place =
    draft.location_mode === 'STRUCTURED' ? normalizePlace(draft.place) : null;

  return {
    title: normalizeText(draft.title),
    time_mode: draft.time_mode,
    start_time: timed ? normalizeText(draft.start_time) || null : null,
    end_time:
      draft.time_mode === 'TIME_RANGE'
        ? normalizeText(draft.end_time) || null
        : null,
    system_type: draft.system_type ?? '',
    custom_type_id:
      draft.system_type === null
        ? normalizeText(draft.custom_type_id ?? '') || null
        : null,
    assignee_scope: draft.assignee_scope,
    assignee_user_id:
      draft.assignee_scope === 'USER'
        ? normalizeText(draft.assignee_user_id ?? '') || null
        : null,
    location_mode: draft.location_mode,
    location_label: normalizeText(draft.location_label),
    location_note: normalizeText(draft.location_note),
    place,
    note: normalizeText(draft.note),
    meeting_point: normalizeText(draft.meeting_point),
    contact_name: normalizeText(draft.contact_name),
    contact_phone: normalizeText(draft.contact_phone),
    booking_reference: normalizeText(draft.booking_reference),
    external_link: normalizeText(draft.external_link),
    reminder_offsets_minutes: timed
      ? [...draft.reminder_offsets_minutes].sort((left, right) => right - left)
      : [],
  };
}

function serializeSectionDraft(
  draft: SectionFormDraft,
): CreateSectionPayload {
  return {
    section_date: draft.section_date,
    label: normalizeText(draft.label),
  };
}

function normalizePlace(
  place: ActivityPlacePayload | null,
): ActivityPlacePayload | null {
  if (place === null) {
    return null;
  }
  return {
    provider: normalizeText(place.provider),
    provider_id: place.provider_id,
    title: normalizeText(place.title),
    address: normalizeText(place.address ?? ''),
    lat: normalizeCoordinate(place.lat),
    lng: normalizeCoordinate(place.lng),
  };
}

function normalizeCoordinate(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value.toFixed(ACTIVITY_COORDINATE_DECIMAL_PLACES));
}

function clonePlace(
  place: ActivityPlacePayload | null,
): ActivityPlacePayload | null {
  return place ? { ...place } : null;
}

function assignDirectDraftField(
  patch: PatchActivityPayload,
  initialPayload: CreateActivityPayload,
  currentPayload: CreateActivityPayload,
  dirtyFields: ActivityFormDirtyFields,
  field:
    | 'note'
    | 'meeting_point'
    | 'contact_name'
    | 'contact_phone'
    | 'booking_reference'
    | 'external_link',
): void {
  if (dirtyFields[field]) {
    assignChanged(patch, initialPayload, currentPayload, field);
  }
}

function assignChanged<K extends keyof CreateActivityPayload>(
  patch: PatchActivityPayload,
  initialPayload: CreateActivityPayload,
  currentPayload: CreateActivityPayload,
  field: K,
): void {
  if (!valuesEqual(initialPayload[field], currentPayload[field])) {
    patch[field] = currentPayload[field];
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function containsId(
  ids: ReadonlySet<string> | readonly string[],
  id: string,
): boolean {
  for (const candidate of ids) {
    if (candidate === id) {
      return true;
    }
  }
  return false;
}

function isTimedMode(timeMode: TimelineActivityTimeMode): boolean {
  return timeMode === 'AT_TIME' || timeMode === 'TIME_RANGE';
}

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function defaultRangeEndTime(startTime: string): string {
  const minutes = Math.min(timeToMinutes(startTime) + 60, 23 * 60 + 59);
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const remainder = String(minutes % 60).padStart(2, '0');
  return `${hours}:${remainder}`;
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:', 'ftps:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function validateRequiredCappedText(
  value: string,
  maxLength: number,
  field: ActivityFormErrorField,
  label: string,
  fieldErrors: ActivityFormFieldErrors,
): void {
  const normalized = normalizeText(value);
  if (!normalized) {
    addError(fieldErrors, field, `${label} is required.`);
  } else if (codePointLength(normalized) > maxLength) {
    addError(
      fieldErrors,
      field,
      `${label} must be ${maxLength} characters or fewer.`,
    );
  }
}

function validateOptionalCappedText(
  value: string,
  maxLength: number,
  field: ActivityFormErrorField,
  label: string,
  fieldErrors: ActivityFormFieldErrors,
): void {
  if (codePointLength(normalizeText(value)) > maxLength) {
    addError(
      fieldErrors,
      field,
      `${label} must be ${maxLength} characters or fewer.`,
    );
  }
}

function addError<TField extends string>(
  fieldErrors: Partial<Record<TField, string>>,
  field: TField,
  message: string,
): void {
  if (fieldErrors[field] === undefined) {
    fieldErrors[field] = message;
  }
}

function normalizeText(value: string): string {
  return value.trim();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
