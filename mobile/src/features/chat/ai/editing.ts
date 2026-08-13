import {
  normalizeAIActionDraftApiError,
  patchAIActionDraft,
  type AIActionDraftApiFailure,
} from './api';
import {
  requireMatchingAIActionDraft,
  type AIActionDraft,
  type AIActionDraftEnvelope,
  type AIActionDraftMissingField,
} from './drafts';

export interface DraftEditingState {
  readonly draft: AIActionDraft;
  readonly editedValues: Readonly<Record<string, unknown>>;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly message: string | null;
  readonly expiredWithUnsavedEdits: boolean;
}

export type BuildDraftPatchResult =
  | { readonly ok: true; readonly payload: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly field: string | null;
      readonly message: string;
    };

export interface DraftEditingDependencies {
  readonly patch: (
    tripId: string,
    draftId: string,
    payload: Readonly<Record<string, unknown>>,
  ) => Promise<AIActionDraftEnvelope>;
  readonly normalizeError: (
    error: unknown,
    requestedDraftId: string,
  ) => AIActionDraftApiFailure;
}

export interface DraftPatchOutcome {
  readonly state: DraftEditingState;
  readonly failure: AIActionDraftApiFailure | null;
  readonly applied: boolean;
}

export const DEFAULT_DRAFT_EDITING_DEPENDENCIES: DraftEditingDependencies = {
  patch: (tripId, draftId, payload) =>
    patchAIActionDraft(tripId, draftId, payload),
  normalizeError: (error, requestedDraftId) =>
    normalizeAIActionDraftApiError(
      error,
      'patch',
      Date.now(),
      requestedDraftId,
    ),
};

function payloadNamesForField(
  field: AIActionDraftMissingField,
): readonly string[] {
  if (field.type === 'target') {
    return [];
  }
  if (field.type !== 'time_range') {
    return [field.name];
  }
  const pair = field.constraints?.pair;
  if (
    Array.isArray(pair) &&
    pair.length === 2 &&
    pair.every(
      (name): name is string => typeof name === 'string' && name.length > 0,
    )
  ) {
    return pair;
  }
  return ['start_time', 'end_time'];
}

export function editablePayloadNames(
  fields: readonly AIActionDraftMissingField[],
): ReadonlySet<string> {
  return new Set(fields.flatMap(payloadNamesForField));
}

function fieldForPayloadName(
  fields: readonly AIActionDraftMissingField[],
  payloadName: string,
): AIActionDraftMissingField | null {
  return (
    fields.find((field) => payloadNamesForField(field).includes(payloadName)) ??
    null
  );
}

export function createDraftEditingState(
  draft: AIActionDraft,
): DraftEditingState {
  return {
    draft,
    editedValues: {},
    fieldErrors: {},
    message: null,
    expiredWithUnsavedEdits: false,
  };
}

export function setDraftEditedValue(
  state: DraftEditingState,
  name: string,
  value: unknown,
): DraftEditingState {
  if (!editablePayloadNames(state.draft.missing_fields).has(name)) {
    return state;
  }
  const fieldErrors = { ...state.fieldErrors };
  delete fieldErrors[name];
  return {
    ...state,
    editedValues: { ...state.editedValues, [name]: value },
    fieldErrors,
    message: null,
  };
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0)
  );
}

export function buildEditedDraftPayload(
  state: DraftEditingState,
): BuildDraftPatchResult {
  const allowed = editablePayloadNames(state.draft.missing_fields);
  const payload: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(state.editedValues)) {
    if (!allowed.has(name) || isBlank(value)) {
      continue;
    }
    const field = fieldForPayloadName(state.draft.missing_fields, name);
    if (field?.type === 'json' && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        payload[name] = parsed;
      } catch {
        return {
          ok: false,
          field: name,
          message: 'Enter valid JSON.',
        };
      }
    } else {
      payload[name] = value;
    }
  }
  if (Object.keys(payload).length === 0) {
    return {
      ok: false,
      field: null,
      message: 'Enter at least one field before saving.',
    };
  }
  return { ok: true, payload };
}

export function rebaseDraftEditingState(
  state: DraftEditingState,
  draft: AIActionDraft,
): DraftEditingState {
  const stillEditable = editablePayloadNames(draft.missing_fields);
  const editedValues: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [name, value] of Object.entries(state.editedValues)) {
    if (stillEditable.has(name)) {
      editedValues[name] = value;
    }
  }
  for (const [name, message] of Object.entries(state.fieldErrors)) {
    if (stillEditable.has(name)) {
      fieldErrors[name] = message;
    }
  }
  return {
    ...state,
    draft,
    editedValues,
    fieldErrors,
  };
}

export async function saveDraftEdits(options: {
  readonly tripId: string;
  readonly state: DraftEditingState;
  readonly dependencies?: DraftEditingDependencies;
}): Promise<DraftPatchOutcome> {
  if (!options.state.draft.can_edit) {
    return {
      applied: false,
      failure: null,
      state: {
        ...options.state,
        message: 'The server does not allow you to edit this draft.',
      },
    };
  }
  const built = buildEditedDraftPayload(options.state);
  if (!built.ok) {
    return {
      applied: false,
      failure: null,
      state: {
        ...options.state,
        message: built.message,
        fieldErrors:
          built.field === null
            ? options.state.fieldErrors
            : { ...options.state.fieldErrors, [built.field]: built.message },
      },
    };
  }

  const dependencies =
    options.dependencies ?? DEFAULT_DRAFT_EDITING_DEPENDENCIES;
  try {
    const response = await dependencies.patch(
      options.tripId,
      options.state.draft.id,
      built.payload,
    );
    const responseDraft = requireMatchingAIActionDraft(
      response.draft,
      options.state.draft.id,
    );
    return {
      applied: true,
      failure: null,
      state: {
        ...rebaseDraftEditingState(options.state, responseDraft),
        message: 'Draft updated.',
        expiredWithUnsavedEdits: false,
      },
    };
  } catch (error: unknown) {
    const normalizedFailure = dependencies.normalizeError(
      error,
      options.state.draft.id,
    );
    let failure = normalizedFailure;
    if (normalizedFailure.draft !== null) {
      try {
        failure = {
          ...normalizedFailure,
          draft: requireMatchingAIActionDraft(
            normalizedFailure.draft,
            options.state.draft.id,
          ),
        };
      } catch {
        failure = { ...normalizedFailure, draft: null };
      }
    }
    const expired =
      failure.errorCode === 'AI_DRAFT_EXPIRED' ||
      failure.draft?.status === 'EXPIRED';
    const currentState =
      failure.draft === null
        ? options.state
        : expired
          ? { ...options.state, draft: failure.draft }
          : rebaseDraftEditingState(options.state, failure.draft);
    return {
      applied: false,
      failure,
      state: {
        ...currentState,
        fieldErrors: failure.fieldErrors ?? currentState.fieldErrors,
        message: expired
          ? 'This draft expired. Your edits were not applied.'
          : failure.errorCode === 'AI_DRAFT_PATCH_FIELD_NOT_ALLOWED'
            ? failure.message || 'That field cannot be edited for this draft.'
            : failure.message,
        expiredWithUnsavedEdits:
          expired && Object.keys(options.state.editedValues).length > 0,
      },
    };
  }
}
