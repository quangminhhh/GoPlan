import type { AIActionDraftApiFailure } from '../api';
import {
  buildEditedDraftPayload,
  createDraftEditingState,
  rebaseDraftEditingState,
  saveDraftEdits,
  setDraftEditedValue,
  type DraftEditingDependencies,
} from '../editing';
import { makeDraftFixture as makeDraft } from '../__fixtures__/drafts';

function failure(
  overrides: Partial<AIActionDraftApiFailure> = {},
): AIActionDraftApiFailure {
  return {
    kind: 'message',
    message: 'Draft update failed.',
    operation: 'patch',
    errorCode: null,
    status: 400,
    retryAfterMs: null,
    fieldErrors: null,
    draft: null,
    ...overrides,
  };
}

function editableDraft() {
  return makeDraft({
    status: 'NEEDS_INFO',
    can_confirm: false,
    can_edit: true,
    missing_fields: [
      { name: 'title', label: 'Title', required: true },
      { name: 'total_amount', label: 'Amount', type: 'money' },
    ],
  });
}

describe('AI draft editing state', () => {
  it('builds PATCH data from edited allowed fields only', () => {
    const initial = createDraftEditingState(editableDraft());
    const disallowed = setDraftEditedValue(initial, 'server_only', 'bad');
    expect(disallowed).toBe(initial);
    const edited = setDraftEditedValue(initial, 'title', 'Lunch');
    expect(buildEditedDraftPayload(edited)).toEqual({
      ok: true,
      payload: { title: 'Lunch' },
    });
  });

  it('expands synthetic time ranges using the server-provided pair', () => {
    const draft = makeDraft({
      status: 'NEEDS_INFO',
      can_confirm: false,
      can_edit: true,
      missing_fields: [
        {
          name: 'time_range',
          label: 'Time',
          type: 'time_range',
          constraints: { pair: ['starts_at', 'ends_at'] },
        },
      ],
    });
    let state = createDraftEditingState(draft);
    state = setDraftEditedValue(state, 'starts_at', '08:00');
    state = setDraftEditedValue(state, 'ends_at', '09:00');
    expect(buildEditedDraftPayload(state)).toEqual({
      ok: true,
      payload: { starts_at: '08:00', ends_at: '09:00' },
    });
  });

  it('parses JSON as unknown data and reports malformed JSON inline', () => {
    const draft = makeDraft({
      status: 'NEEDS_INFO',
      can_confirm: false,
      can_edit: true,
      missing_fields: [{ name: 'data', label: 'Details', type: 'json' }],
    });
    const valid = setDraftEditedValue(
      createDraftEditingState(draft),
      'data',
      '{"title":"Museum"}',
    );
    expect(buildEditedDraftPayload(valid)).toEqual({
      ok: true,
      payload: { data: { title: 'Museum' } },
    });
    const invalid = setDraftEditedValue(valid, 'data', '{bad');
    expect(buildEditedDraftPayload(invalid)).toEqual({
      ok: false,
      field: 'data',
      message: 'Enter valid JSON.',
    });
  });

  it('rebases partial server updates and does not resubmit fields no longer missing', () => {
    let state = createDraftEditingState(editableDraft());
    state = setDraftEditedValue(state, 'title', 'Lunch');
    state = setDraftEditedValue(state, 'total_amount', '500000');
    const nextDraft = makeDraft({
      status: 'NEEDS_INFO',
      can_confirm: false,
      can_edit: true,
      updated_at: '2026-05-13T00:01:00.000Z',
      missing_fields: [
        { name: 'total_amount', label: 'Amount', type: 'money' },
      ],
    });
    const rebased = rebaseDraftEditingState(state, nextDraft);
    expect(rebased.editedValues).toEqual({ total_amount: '500000' });
    expect(buildEditedDraftPayload(rebased)).toEqual({
      ok: true,
      payload: { total_amount: '500000' },
    });
  });

  it('uses the strict payload, applies the returned draft, and lets status flip to READY', async () => {
    const patch = jest.fn(async () => ({
      draft: makeDraft({
        status: 'READY',
        can_confirm: true,
        can_edit: false,
        missing_fields: [],
      }),
    }));
    const dependencies: DraftEditingDependencies = {
      patch,
      normalizeError: jest.fn(),
    };
    const state = setDraftEditedValue(
      createDraftEditingState(editableDraft()),
      'title',
      'Lunch',
    );
    const outcome = await saveDraftEdits({
      tripId: 'trip-1',
      state,
      dependencies,
    });
    expect(patch).toHaveBeenCalledWith('trip-1', '22222222-2222-4222-8222-222222222222', {
      title: 'Lunch',
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.state.draft.status).toBe('READY');
  });

  it('applies optional error drafts and structured field errors', async () => {
    const current = editableDraft();
    const serverDraft = makeDraft({
      status: 'NEEDS_INFO',
      can_confirm: false,
      can_edit: true,
      updated_at: '2026-05-13T00:02:00.000Z',
      missing_fields: [{ name: 'total_amount', label: 'Amount', type: 'money' }],
    });
    const apiFailure = failure({
      errorCode: 'FIELD_VALIDATION_FAILED',
      fieldErrors: { total_amount: 'Enter a positive amount.' },
      draft: serverDraft,
    });
    const state = setDraftEditedValue(
      createDraftEditingState(current),
      'total_amount',
      '-1',
    );
    const outcome = await saveDraftEdits({
      tripId: 'trip-1',
      state,
      dependencies: {
        patch: jest.fn(async () => Promise.reject(new Error('validation'))),
        normalizeError: () => apiFailure,
      },
    });
    expect(outcome.state.draft.updated_at).toBe(serverDraft.updated_at);
    expect(outcome.state.fieldErrors).toEqual({
      total_amount: 'Enter a positive amount.',
    });
  });

  it('retains unsaved values and plainly reports expiry mid-edit', async () => {
    const state = setDraftEditedValue(
      createDraftEditingState(editableDraft()),
      'title',
      'Do not lose this',
    );
    const expired = makeDraft({
      status: 'EXPIRED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      missing_fields: [],
    });
    const outcome = await saveDraftEdits({
      tripId: 'trip-1',
      state,
      dependencies: {
        patch: jest.fn(async () => Promise.reject(new Error('expired'))),
        normalizeError: () =>
          failure({
            message: 'Draft expired.',
            errorCode: 'AI_DRAFT_EXPIRED',
            status: 409,
            draft: expired,
          }),
      },
    });
    expect(outcome.state.message).toBe(
      'This draft expired. Your edits were not applied.',
    );
    expect(outcome.state.expiredWithUnsavedEdits).toBe(true);
    expect(outcome.state.editedValues).toEqual({ title: 'Do not lose this' });
  });

  it('never calls PATCH when can_edit is false', async () => {
    const patch = jest.fn();
    const state = createDraftEditingState(makeDraft({ can_edit: false }));
    const outcome = await saveDraftEdits({
      tripId: 'trip-1',
      state,
      dependencies: { patch, normalizeError: jest.fn() },
    });
    expect(patch).not.toHaveBeenCalled();
    expect(outcome.state.message).toContain('does not allow');
  });
});
