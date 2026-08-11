export const AI_ACTION_DRAFT_STATUSES = [
  'NEEDS_INFO',
  'READY',
  'CONFIRMED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
] as const;

export type AIActionDraftStatus = (typeof AI_ACTION_DRAFT_STATUSES)[number];

export const KNOWN_AI_ACTION_TYPES = [
  'timeline.activity.create',
  'timeline.activity.update',
  'timeline.activity.delete',
  'timeline.activity.status.update',
  'expense.create',
  'expense.update',
  'expense.delete',
  'expense.contribution.set',
  'settlement.finalize',
  'settlement.reopen',
  'settlement.transfer.mark_sent',
  'settlement.transfer.confirm_received',
] as const;

export type KnownAIActionType = (typeof KNOWN_AI_ACTION_TYPES)[number];
export type OpaqueAIValue = Readonly<Record<string, unknown>>;

export type AIActionDraftOption = Readonly<Record<string, unknown>> & {
  readonly label: string;
  readonly value: string;
};

export type AIActionDraftPreset = Readonly<Record<string, unknown>> & {
  readonly label: string;
  readonly start: string;
  readonly end: string;
};

export type AIActionDraftMissingField = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly constraints?: OpaqueAIValue;
  readonly options?: readonly AIActionDraftOption[];
  readonly presets?: readonly AIActionDraftPreset[];
};

/**
 * The server owns the action vocabulary and confirmation authority. Open
 * strings and opaque presentation records are intentional: a future server
 * value must remain visible instead of being stripped or crashing chat.
 */
export type AIActionDraft = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly action_type: string;
  readonly status: AIActionDraftStatus;
  readonly required_confirmation: string;
  readonly can_confirm: boolean;
  readonly can_cancel: boolean;
  readonly can_edit: boolean;
  readonly display: OpaqueAIValue;
  readonly summary: string;
  readonly preview: OpaqueAIValue;
  readonly missing_fields: readonly AIActionDraftMissingField[];
  readonly result: OpaqueAIValue;
  readonly error_code: string;
  readonly error_detail: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export interface AIActionDraftEnvelope {
  readonly draft: AIActionDraft;
}

export class AIActionDraftContractError extends Error {
  constructor() {
    super('The AI action draft server returned an invalid response.');
    this.name = 'AIActionDraftContractError';
  }
}

export function isAIRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalizeAIUuid(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

/** Binds a parsed response draft to the resource requested by the caller. */
export function requireMatchingAIActionDraft(
  draft: AIActionDraft,
  requestedDraftId: string,
): AIActionDraft {
  const expectedId = canonicalizeAIUuid(requestedDraftId);
  const actualId = canonicalizeAIUuid(draft.id);
  if (expectedId === null || actualId === null || actualId !== expectedId) {
    throw new AIActionDraftContractError();
  }
  return actualId === draft.id ? draft : { ...draft, id: actualId };
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

export function isAIActionDraftStatus(
  value: unknown,
): value is AIActionDraftStatus {
  return AI_ACTION_DRAFT_STATUSES.some((status) => status === value);
}

export function isKnownAIActionType(
  value: string,
): value is KnownAIActionType {
  return KNOWN_AI_ACTION_TYPES.some((actionType) => actionType === value);
}

/**
 * Viewer permissions are computed outside the draft row and can change without
 * advancing updated_at. Keep them in the UI source identity so revoked
 * authority can never inherit stale local controls or review state.
 */
export function aiActionDraftSourceIdentity(draft: AIActionDraft): string {
  return JSON.stringify([
    draft.id,
    draft.action_type,
    draft.status,
    draft.updated_at,
    draft.expires_at,
    draft.required_confirmation,
    draft.can_confirm,
    draft.can_cancel,
    draft.can_edit,
  ]);
}

function stableAIValueIdentity(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableAIValueIdentity).join(',')}]`;
  }
  if (isAIRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableAIValueIdentity(value[key])}`,
      )
      .join(',')}}`;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value));
}

/**
 * Security identity for an explicit mutation review. Unlike the lightweight
 * UI source identity, this includes every parsed server field (including
 * opaque future fields), so a preflight GET can never continue an approval
 * against changed content merely because the row timestamp stayed equal.
 */
export function aiActionDraftMutationSnapshotIdentity(
  draft: AIActionDraft,
): string {
  return stableAIValueIdentity(draft);
}

function parseOption(value: unknown): AIActionDraftOption | null {
  if (
    !isAIRecord(value) ||
    typeof value.label !== 'string' ||
    typeof value.value !== 'string'
  ) {
    return null;
  }
  return { ...value, label: value.label, value: value.value };
}

function parsePreset(value: unknown): AIActionDraftPreset | null {
  if (
    !isAIRecord(value) ||
    typeof value.label !== 'string' ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string'
  ) {
    return null;
  }
  return {
    ...value,
    label: value.label,
    start: value.start,
    end: value.end,
  };
}

function parseOptionalList<T>(
  value: unknown,
  parseItem: (candidate: unknown) => T | null,
): readonly T[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed: T[] = [];
  for (const candidate of value) {
    const item = parseItem(candidate);
    if (item === null) {
      return null;
    }
    parsed.push(item);
  }
  return parsed;
}

function parseMissingField(value: unknown): AIActionDraftMissingField | null {
  if (
    !isAIRecord(value) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.label) ||
    (value.type !== undefined && typeof value.type !== 'string') ||
    (value.required !== undefined && typeof value.required !== 'boolean') ||
    (value.constraints !== undefined && !isAIRecord(value.constraints))
  ) {
    return null;
  }

  const options = parseOptionalList(value.options, parseOption);
  const presets = parseOptionalList(value.presets, parsePreset);
  if (options === null || presets === null) {
    return null;
  }

  return {
    ...value,
    name: value.name,
    label: value.label,
    ...(typeof value.type === 'string' ? { type: value.type } : {}),
    ...(typeof value.required === 'boolean'
      ? { required: value.required }
      : {}),
    ...(isAIRecord(value.constraints)
      ? { constraints: { ...value.constraints } }
      : {}),
    ...(options !== undefined ? { options } : {}),
    ...(presets !== undefined ? { presets } : {}),
  };
}

function parseMissingFields(
  value: unknown,
): readonly AIActionDraftMissingField[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const fields: AIActionDraftMissingField[] = [];
  const names = new Set<string>();
  for (const candidate of value) {
    const field = parseMissingField(candidate);
    if (field === null || names.has(field.name)) {
      return null;
    }
    names.add(field.name);
    fields.push(field);
  }
  return fields;
}

export function parseAIActionDraft(value: unknown): AIActionDraft | null {
  if (!isAIRecord(value)) {
    return null;
  }
  const missingFields = parseMissingFields(value.missing_fields);
  const id = typeof value.id === 'string' ? canonicalizeAIUuid(value.id) : null;
  if (
    id === null ||
    !isNonEmptyString(value.action_type) ||
    !isAIActionDraftStatus(value.status) ||
    typeof value.required_confirmation !== 'string' ||
    typeof value.can_confirm !== 'boolean' ||
    typeof value.can_cancel !== 'boolean' ||
    typeof value.can_edit !== 'boolean' ||
    !isAIRecord(value.display) ||
    typeof value.summary !== 'string' ||
    !isAIRecord(value.preview) ||
    missingFields === null ||
    !isAIRecord(value.result) ||
    typeof value.error_code !== 'string' ||
    typeof value.error_detail !== 'string' ||
    !isTimestamp(value.expires_at) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) {
    return null;
  }

  return {
    ...value,
    id,
    action_type: value.action_type,
    status: value.status,
    required_confirmation: value.required_confirmation,
    can_confirm: value.can_confirm,
    can_cancel: value.can_cancel,
    can_edit: value.can_edit,
    display: { ...value.display },
    summary: value.summary,
    preview: { ...value.preview },
    missing_fields: missingFields,
    result: { ...value.result },
    error_code: value.error_code,
    error_detail: value.error_detail,
    expires_at: value.expires_at,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

export function requireAIActionDraft(value: unknown): AIActionDraft {
  const draft = parseAIActionDraft(value);
  if (draft === null) {
    throw new AIActionDraftContractError();
  }
  return draft;
}

export function requireAIActionDraftEnvelope(
  value: unknown,
): AIActionDraftEnvelope {
  if (!isAIRecord(value)) {
    throw new AIActionDraftContractError();
  }
  return { draft: requireAIActionDraft(value.draft) };
}

export function requireMatchingAIActionDraftEnvelope(
  value: unknown,
  requestedDraftId: string,
): AIActionDraftEnvelope {
  const envelope = requireAIActionDraftEnvelope(value);
  return {
    draft: requireMatchingAIActionDraft(envelope.draft, requestedDraftId),
  };
}
