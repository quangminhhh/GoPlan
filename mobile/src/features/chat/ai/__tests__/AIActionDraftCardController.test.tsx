import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  AxiosError,
  AxiosHeaders,
  type InternalAxiosRequestConfig,
} from 'axios';
import { Suspense, useState } from 'react';
import type { AIActionDraftEnvelope } from '../drafts';
import { AIActionDraftCardController } from '../components/AIActionDraftCardController';
import { makeDraftFixture as makeDraft } from '../__fixtures__/drafts';
import {
  createAIReconciliationCoordinator,
  reconcileNewlyConfirmedDraft,
  type AIReconciliationCoordinator,
} from '../reconciliation';
import { AIReconciliationCoordinatorProvider } from '../reconciliationContext';

jest.mock('../api', () => {
  const actual = jest.requireActual<typeof import('../api')>('../api');
  return {
    ...actual,
    cancelAIActionDraft: jest.fn(),
    getAIActionDraft: jest.fn(),
    patchAIActionDraft: jest.fn(),
  };
});

jest.mock('../confirmController', () => {
  const actual = jest.requireActual<typeof import('../confirmController')>(
    '../confirmController',
  );
  return {
    ...actual,
    checkConfirmStatus: jest.fn(),
    confirmDraftAfterExplicitApproval: jest.fn(),
  };
});

jest.mock('../reconciliation', () => {
  const actual = jest.requireActual<typeof import('../reconciliation')>(
    '../reconciliation',
  );
  return {
    ...actual,
    reconcileNewlyConfirmedDraft: jest.fn(),
  };
});

jest.mock('../accessibilityFocus', () => ({
  focusAccessibilityNode: jest.fn(),
}));

// eslint-disable-next-line import/first
import {
  cancelAIActionDraft,
  getAIActionDraft,
  patchAIActionDraft,
} from '../api';
// eslint-disable-next-line import/first
import {
  checkConfirmStatus,
  confirmDraftAfterExplicitApproval,
  createConfirmAmbiguityState,
} from '../confirmController';
// eslint-disable-next-line import/first
import { createAIActionDraftControllerSessionStore } from '../controllerSession';
// eslint-disable-next-line import/first
import { focusAccessibilityNode } from '../accessibilityFocus';
// eslint-disable-next-line import/first
import * as reconciliationContext from '../reconciliationContext';

const mockPatch = jest.mocked(patchAIActionDraft);
const mockCancel = jest.mocked(cancelAIActionDraft);
const mockGet = jest.mocked(getAIActionDraft);
const mockConfirm = jest.mocked(confirmDraftAfterExplicitApproval);
const mockCheck = jest.mocked(checkConfirmStatus);
const mockReconcile = jest.mocked(reconcileNewlyConfirmedDraft);
const mockFocusAccessibilityNode = jest.mocked(focusAccessibilityNode);
const TRIP_A = '11111111-1111-4111-8111-111111111111';
const TRIP_B = '22222222-2222-4222-8222-222222222222';

function editableDraft(id: string, title: string) {
  return makeDraft({
    id,
    status: 'NEEDS_INFO',
    can_confirm: false,
    can_cancel: true,
    can_edit: true,
    display: { title, kicker: 'Expense' },
    missing_fields: [{ name: 'title', label: 'Title' }],
  });
}

function readyDraft(id: string, title: string) {
  return makeDraft({
    id,
    status: 'READY',
    can_confirm: true,
    can_cancel: true,
    can_edit: false,
    display: { title, kicker: 'Expense' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function axiosConfig(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders() };
}

function expiredPatchError(draft: ReturnType<typeof makeDraft>): AxiosError {
  const config = axiosConfig();
  return new AxiosError('Draft expired', 'ERR_BAD_RESPONSE', config, {}, {
    status: 409,
    data: {
      detail: 'Draft expired.',
      error_code: 'AI_DRAFT_EXPIRED',
      draft,
    },
    headers: new AxiosHeaders(),
    statusText: 'Conflict',
    config,
  });
}

async function flushPresentationCarryover(): Promise<void> {
  await act(
    async () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );
}

describe('AIActionDraftCardController resource lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcile.mockResolvedValue(null);
  });

  it('does not mutate the room session store during an abandoned render', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Abandoned draft',
    );
    const sessionStore = createAIActionDraftControllerSessionStore(
      `user-a:${TRIP_A}`,
    );
    const setSession = jest.spyOn(sessionStore, 'set');
    const useSessionStore = jest
      .spyOn(
        reconciliationContext,
        'useRoomAIActionDraftControllerSessionStore',
      )
      .mockReturnValue(sessionStore);
    function SuspendRender(): never {
      throw new Promise<void>(() => undefined);
    }

    try {
      const rendered = await render(
        <Suspense fallback={null}>
            <AIActionDraftCardController
              draft={draft}
              onDraftChanged={jest.fn()}
              tripId={TRIP_A}
            />
            <SuspendRender />
        </Suspense>,
      );
      expect(setSession).not.toHaveBeenCalled();
      await rendered.unmount();
    } finally {
      useSessionStore.mockRestore();
    }
  });

  it('keeps server-authorized controls visible but starts no controller operation while interaction is disabled', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Read-only draft',
    );
    await render(
      <AIActionDraftCardController
        draft={draft}
        interactionDisabled
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    for (const label of ['Cancel', 'Confirm']) {
      const control = screen.getByRole('button', { name: label });
      expect(control.props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(control);
    }
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('aborts resource A and ignores its late completion after switching to B', async () => {
    const pendingA = deferred<AIActionDraftEnvelope>();
    let signalA: AbortSignal | undefined;
    mockPatch.mockImplementationOnce(async (_tripId, _draftId, _payload, signal) => {
      signalA = signal;
      return pendingA.promise;
    });
    const changedA = jest.fn();
    const changedB = jest.fn();
    const draftA = editableDraft('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft A');
    const draftB = editableDraft('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Draft B');
    mockGet.mockResolvedValueOnce({ draft: draftA });
    const rendered = await render(
      <AIActionDraftCardController
        draft={draftA}
        onDraftChanged={changedA}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Late A');
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft information' }));
    expect(signalA?.aborted).toBe(false);

    await rendered.rerender(
      <AIActionDraftCardController
        draft={draftB}
        onDraftChanged={changedB}
        tripId={TRIP_B}
      />,
    );
    expect(signalA?.aborted).toBe(true);
    expect(screen.getByText('Draft B')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit draft' }).props.accessibilityState.disabled).toBe(
      false,
    );

    await act(async () => {
      pendingA.resolve({
        draft: makeDraft({ ...draftA, updated_at: '2026-05-13T01:00:00.000Z' }),
      });
      await pendingA.promise;
    });
    expect(changedA).not.toHaveBeenCalled();
    expect(changedB).not.toHaveBeenCalled();
    expect(screen.getByText('Draft B')).toBeTruthy();
  });

  it('aborts and fences a late completion after unmount', async () => {
    const pending = deferred<AIActionDraftEnvelope>();
    let signal: AbortSignal | undefined;
    mockPatch.mockImplementationOnce(async (_tripId, _draftId, _payload, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    const changed = jest.fn();
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    mockGet.mockResolvedValueOnce({ draft: source });
    const rendered = await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={changed}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Late A');
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft information' }));
    await rendered.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve({ draft: editableDraft('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Late') });
      await pending.promise;
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it('aborts an old operation when the same draft receives a newer permission snapshot', async () => {
    const pending = deferred<AIActionDraftEnvelope>();
    let signal: AbortSignal | undefined;
    mockPatch.mockImplementationOnce(async (_tripId, _draftId, _payload, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    const changed = jest.fn();
    const draftId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oldDraft = editableDraft(draftId, 'Old draft');
    mockGet.mockResolvedValueOnce({ draft: oldDraft });
    const rendered = await render(
      <AIActionDraftCardController
        draft={oldDraft}
        onDraftChanged={changed}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Stale edit');
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft information' }));
    const newerDraft = makeDraft({
      ...oldDraft,
      can_cancel: false,
      can_edit: false,
      display: { title: 'New permission snapshot', kicker: 'Expense' },
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    await rendered.rerender(
      <AIActionDraftCardController
        draft={newerDraft}
        onDraftChanged={changed}
        tripId={TRIP_A}
      />,
    );
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText('New permission snapshot')).toBeTruthy();
    await act(async () => {
      pending.resolve({
        draft: makeDraft({
          ...oldDraft,
          display: { title: 'Stale response', kicker: 'Expense' },
          updated_at: '2026-05-13T00:05:00.000Z',
        }),
      });
      await pending.promise;
    });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText('New permission snapshot')).toBeTruthy();
    expect(screen.queryByText('Stale response')).toBeNull();
  });

  it('fails closed when a mocked PATCH returns another valid draft id', async () => {
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Original draft',
    );
    mockGet.mockResolvedValueOnce({ draft: source });
    mockPatch.mockResolvedValueOnce({
      draft: editableDraft(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'Wrong draft',
      ),
    });
    const changed = jest.fn();
    await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={changed}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Edited title');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText('Original draft')).toBeTruthy();
    expect(screen.queryByText('Wrong draft')).toBeNull();
    expect(screen.getByText(/invalid response/i)).toBeTruthy();
  });

  it('keeps rejected editor values visible and read-only after PATCH returns expiry authority', async () => {
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const expired = makeDraft({
      ...source,
      status: 'EXPIRED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      missing_fields: [],
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    mockGet.mockResolvedValueOnce({ draft: source });
    mockPatch.mockRejectedValueOnce(expiredPatchError(expired));

    function Harness() {
      const [draft, setDraft] = useState(source);
      return (
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={setDraft}
          tripId={TRIP_A}
        />
      );
    }

    await render(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Do not lose this');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    expect(screen.getByLabelText('Draft status: Expired')).toBeTruthy();
    expect(screen.getByLabelText('Title').props.value).toBe('Do not lose this');
    expect(screen.getByLabelText('Title').props.editable).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Save draft information' }).props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByText('This draft expired. Your edits were not applied.'),
    ).toBeTruthy();
    await flushPresentationCarryover();
  });

  it('aborts and fences a late cancel after switching resources', async () => {
    const pending = deferred<AIActionDraftEnvelope>();
    let signal: AbortSignal | undefined;
    mockCancel.mockImplementationOnce(async (_tripId, _draftId, requestSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    const changedA = jest.fn();
    const changedB = jest.fn();
    const draftA = readyDraft('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft A');
    const draftB = readyDraft('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Draft B');
    mockGet.mockResolvedValueOnce({ draft: draftA });
    const rendered = await render(
      <AIActionDraftCardController
        draft={draftA}
        onDraftChanged={changedA}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel this draft' }));
    expect(signal?.aborted).toBe(false);
    await rendered.rerender(
      <AIActionDraftCardController
        draft={draftB}
        onDraftChanged={changedB}
        tripId={TRIP_B}
      />,
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve({
        draft: makeDraft({ ...draftA, status: 'CANCELLED', can_cancel: false }),
      });
      await pending.promise;
    });
    expect(changedA).not.toHaveBeenCalled();
    expect(changedB).not.toHaveBeenCalled();
    expect(screen.getByText('Draft B')).toBeTruthy();
  });

  it.each([
    ['CANCELLED', 'Draft cancelled.'],
    ['EXPIRED', 'The draft expired before it could be cancelled.'],
    ['FAILED', 'The draft failed and was not cancelled.'],
  ] as const)(
    'describes a cancel response with terminal status %s truthfully',
    async (status, message) => {
      const source = readyDraft(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Draft A',
      );
      mockGet.mockResolvedValueOnce({ draft: source });
      mockCancel.mockResolvedValueOnce({
        draft: makeDraft({
          ...source,
          status,
          can_confirm: false,
          can_cancel: false,
          can_edit: false,
        }),
      });
      const changed = jest.fn();
      await render(
        <AIActionDraftCardController
          draft={source}
          onDraftChanged={changed}
          tripId={TRIP_A}
        />,
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      await fireEvent.press(
        screen.getByRole('button', { name: 'Cancel this draft' }),
      );
      expect(screen.getByText(message)).toBeTruthy();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(mockReconcile).not.toHaveBeenCalled();
    },
  );

  it('reconciles exactly once and never claims cancellation when cancel observes CONFIRMED', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const confirmed = makeDraft({
      ...source,
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
    });
    mockGet.mockResolvedValueOnce({ draft: source });
    mockCancel.mockResolvedValueOnce({ draft: confirmed });
    const changed = jest.fn();

    function Harness() {
      const [draft, setDraft] = useState(source);
      return (
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={(next) => {
            changed(next);
            setDraft(next);
          }}
          tripId={TRIP_A}
        />
      );
    }

    await render(<Harness />);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Cancel this draft' }),
    );
    expect(
      screen.getByText('The draft was already confirmed and could not be cancelled.'),
    ).toBeTruthy();
    expect(screen.queryByText('Draft cancelled.')).toBeNull();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith({
      tripId: TRIP_A,
      previousStatus: 'READY',
      draft: confirmed,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    await flushPresentationCarryover();
  });

  it('aborts and fences a late confirm after switching resources', async () => {
    const draftA = readyDraft('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft A');
    const draftB = readyDraft('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Draft B');
    const pending = deferred<ReturnType<typeof createConfirmAmbiguityState>>();
    let signal: AbortSignal | undefined;
    mockConfirm.mockImplementationOnce(async (options) => {
      signal = options.signal;
      return pending.promise;
    });
    const changedA = jest.fn();
    const changedB = jest.fn();
    mockGet.mockResolvedValueOnce({ draft: draftA });
    const rendered = await render(
      <AIActionDraftCardController
        draft={draftA}
        onDraftChanged={changedA}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm this action' }));
    expect(signal?.aborted).toBe(false);
    await rendered.rerender(
      <AIActionDraftCardController
        draft={draftB}
        onDraftChanged={changedB}
        tripId={TRIP_B}
      />,
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(
        createConfirmAmbiguityState(
          makeDraft({ ...draftA, status: 'CONFIRMED', can_confirm: false }),
        ),
      );
      await pending.promise;
    });
    expect(changedA).not.toHaveBeenCalled();
    expect(changedB).not.toHaveBeenCalled();
    expect(screen.getByText('Draft B')).toBeTruthy();
  });

  it('hides confirm after ambiguity, then aborts and fences a late Check status', async () => {
    const draftA = readyDraft('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft A');
    const draftB = readyDraft('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Draft B');
    const unknown = {
      ...createConfirmAmbiguityState(draftA),
      kind: 'unknown' as const,
      message: 'The confirmation outcome is unknown.',
      canCheckStatus: true,
    };
    mockConfirm.mockResolvedValueOnce(unknown);
    mockGet.mockResolvedValueOnce({ draft: draftA });
    const pending = deferred<ReturnType<typeof createConfirmAmbiguityState>>();
    let signal: AbortSignal | undefined;
    mockCheck.mockImplementationOnce(async (options) => {
      signal = options.signal;
      return pending.promise;
    });
    const changedA = jest.fn();
    const changedB = jest.fn();
    const rendered = await render(
      <AIActionDraftCardController
        draft={draftA}
        onDraftChanged={changedA}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm this action' }));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm this action' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Check status' })).toHaveLength(1);
    const callsBeforeCheck = changedA.mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: 'Check status' }));
    expect(signal?.aborted).toBe(false);
    await rendered.rerender(
      <AIActionDraftCardController
        draft={draftB}
        onDraftChanged={changedB}
        tripId={TRIP_B}
      />,
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(createConfirmAmbiguityState(draftA));
      await pending.promise;
    });
    expect(changedA).toHaveBeenCalledTimes(callsBeforeCheck);
    expect(changedB).not.toHaveBeenCalled();
    expect(screen.getByText('Draft B')).toBeTruthy();
  });

  it('keeps 429 READY confirmation disabled until Retry-After then requires a new modal approval', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-08-10T00:00:00.000Z'));
    let unmount: (() => void | Promise<void>) | null = null;
    try {
      const draft = readyDraft(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Draft A',
      );
      const readyAfterStatusCheck = makeDraft({
        ...draft,
        updated_at: '2026-05-13T00:10:00.000Z',
      });
      mockGet.mockResolvedValueOnce({ draft });
      mockConfirm.mockResolvedValueOnce({
        ...createConfirmAmbiguityState(readyAfterStatusCheck),
        kind: 'ready_for_explicit_confirmation',
        failure: {
          kind: 'throttled',
          message: 'GoPlanAI allows 30 action confirmations per hour.',
          operation: 'confirm',
          errorCode: 'THROTTLED',
          status: 429,
          retryAfterMs: 2_000,
          fieldErrors: null,
          draft: null,
        },
        message:
          'GoPlanAI allows 30 action confirmations per hour. Retry-After: 2 seconds. The action is still ready for a new explicit confirmation.',
        confirmRetryAtMs: Date.now() + 2_000,
      });
      function Harness() {
        const [current, setCurrent] = useState(draft);
        return (
          <AIActionDraftCardController
            draft={current}
            onDraftChanged={setCurrent}
            tripId={TRIP_A}
          />
        );
      }
      const rendered = await render(<Harness />);
      unmount = rendered.unmount;
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm this action' }),
      );
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/30 action confirmations per hour/)).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Confirm' }).props.accessibilityState
          .disabled,
      ).toBe(true);
      expect(screen.getByText('Confirmation available in 2s')).toBeTruthy();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000);
      });
      expect(
        screen.getByRole('button', { name: 'Confirm' }).props.accessibilityState
          .disabled,
      ).toBe(false);
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      expect(
        screen.getByRole('button', { name: 'Confirm this action' }),
      ).toBeTruthy();
      expect(mockConfirm).toHaveBeenCalledTimes(1);
    } finally {
      await unmount?.();
      jest.useRealTimers();
    }
  });

  it('retains 429 metadata and Check status when the follow-up GET outcome is unknown', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    mockGet.mockResolvedValueOnce({ draft });
    mockConfirm.mockResolvedValueOnce({
      ...createConfirmAmbiguityState(draft),
      kind: 'unknown',
      failure: {
        kind: 'throttled',
        message: 'GoPlanAI allows 30 action confirmations per hour.',
        operation: 'confirm',
        errorCode: 'THROTTLED',
        status: 429,
        retryAfterMs: 30_000,
        fieldErrors: null,
        draft: null,
      },
      message:
        'GoPlanAI allows 30 action confirmations per hour. Retry-After: 30 seconds. The status check failed.',
      canCheckStatus: true,
      confirmRetryAtMs: Date.now() + 30_000,
    });
    await render(
      <AIActionDraftCardController
        draft={draft}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(screen.getByText(/Retry-After: 30 seconds/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Check status' })).toHaveLength(1);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps an ambiguous confirm session across a virtualized row unmount without offering a second POST', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const unknown = {
      ...createConfirmAmbiguityState(draft),
      kind: 'unknown' as const,
      message:
        'The confirmation outcome is unknown. Use Check status; do not confirm again.',
      canCheckStatus: true,
    };
    mockGet.mockResolvedValueOnce({ draft });
    mockConfirm.mockResolvedValueOnce(unknown);
    const changed = jest.fn();
    const row = (visible: boolean) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={changed}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true));

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    await rendered.rerender(row(false));
    await rendered.rerender(row(true));

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('fails closed to Check status when virtualization aborts an in-flight confirm', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const pendingConfirm =
      deferred<ReturnType<typeof createConfirmAmbiguityState>>();
    let confirmSignal: AbortSignal | undefined;
    mockGet.mockResolvedValueOnce({ draft });
    mockConfirm.mockImplementationOnce(async (options) => {
      confirmSignal = options.signal;
      return pendingConfirm.promise;
    });
    const row = (visible: boolean) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true));

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(confirmSignal?.aborted).toBe(false);

    await rendered.rerender(row(false));
    expect(confirmSignal?.aborted).toBe(true);
    await rendered.rerender(row(true));

    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingConfirm.resolve(createConfirmAmbiguityState(draft));
      await pendingConfirm.promise;
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('rebases an offscreen unknown session when authoritative CONFIRMED arrives before remount', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const confirmed = makeDraft({
      ...draft,
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    mockGet.mockResolvedValueOnce({ draft });
    mockConfirm.mockResolvedValueOnce({
      ...createConfirmAmbiguityState(draft),
      kind: 'unknown',
      message: 'The confirmation outcome is unknown.',
      canCheckStatus: true,
    });
    const row = (visible: boolean, incoming: ReturnType<typeof makeDraft>) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={incoming}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true, draft));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    await rendered.rerender(row(false, draft));
    await rendered.rerender(row(false, confirmed));
    await rendered.rerender(row(true, confirmed));

    expect(screen.getByLabelText('Draft status: Confirmed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not leak an unknown session across users in the same trip resource', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const coordinatorA = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const coordinatorB = createAIReconciliationCoordinator({
      resourceKey: `user-b:${TRIP_A}`,
      tripId: TRIP_A,
    });
    mockGet.mockResolvedValueOnce({ draft });
    mockConfirm.mockResolvedValueOnce({
      ...createConfirmAmbiguityState(draft),
      kind: 'unknown',
      message: 'The confirmation outcome is unknown.',
      canCheckStatus: true,
    });
    const row = (coordinator: AIReconciliationCoordinator) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(coordinatorA));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    await rendered.rerender(row(coordinatorB));

    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps a future Retry-After unknown session across a virtualized row unmount', async () => {
    const draft = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    mockGet.mockResolvedValueOnce({ draft });
    mockConfirm.mockResolvedValueOnce({
      ...createConfirmAmbiguityState(draft),
      kind: 'unknown',
      failure: {
        kind: 'throttled',
        message: 'GoPlanAI allows 30 action confirmations per hour.',
        operation: 'confirm',
        errorCode: 'THROTTLED',
        status: 429,
        retryAfterMs: 30_000,
        fieldErrors: null,
        draft: null,
      },
      message:
        'GoPlanAI allows 30 action confirmations per hour. Retry-After: 30 seconds. The confirmation outcome is unknown.',
      canCheckStatus: true,
      confirmRetryAtMs: Date.now() + 30_000,
    });
    const row = (visible: boolean) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true));

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(mockConfirm).toHaveBeenCalledTimes(1);

    await rendered.rerender(row(false));
    await rendered.rerender(row(true));

    expect(screen.getByText(/Retry-After: 30 seconds/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps exact expired PATCH values across a virtualized row unmount', async () => {
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const expired = makeDraft({
      ...source,
      status: 'EXPIRED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const pendingPatch = deferred<AIActionDraftEnvelope>();
    mockGet.mockResolvedValueOnce({ draft: source });
    mockPatch.mockReturnValueOnce(pendingPatch.promise);
    const row = (visible: boolean, draft: ReturnType<typeof makeDraft>) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true, source));

    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    const exactSubmittedTitle = '  Preserve\nthese exact bytes  ';
    await fireEvent.changeText(
      screen.getByLabelText('Title'),
      exactSubmittedTitle,
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    await rendered.rerender(row(true, expired));
    expect(screen.getByLabelText('Title').props.value).toBe(
      exactSubmittedTitle,
    );

    await rendered.rerender(row(false, expired));
    await rendered.rerender(row(true, expired));

    expect(screen.getByLabelText('Title').props.value).toBe(
      exactSubmittedTitle,
    );
    expect(screen.getByLabelText('Title').props.editable).toBe(false);
    expect(
      screen.getByText('This draft expired. Your edits were not applied.'),
    ).toBeTruthy();
    await act(async () => {
      pendingPatch.resolve({ draft: expired });
      await pendingPatch.promise;
    });
  });

  it('keeps an open editor and exact unsaved multi-field values across row detach', async () => {
    const source = makeDraft({
      ...editableDraft(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Draft A',
      ),
      missing_fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'notes', label: 'Notes', type: 'text', required: false },
      ],
    });
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const row = (visible: boolean, draft = source) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    const exactTitle = '  Unsaved\n title  ';
    const exactNotes = '  Preserve   notes  ';
    const titleInput = screen.getByLabelText('Title');
    const notesInput = screen.getByLabelText('Notes');
    await act(async () => {
      titleInput.props.onChangeText(exactTitle);
      notesInput.props.onChangeText(exactNotes);
    });

    await rendered.rerender(row(false));
    await rendered.rerender(row(true));

    expect(screen.getByTestId('ai-draft-field-editor')).toBeTruthy();
    expect(screen.getByLabelText('Title').props.value).toBe(exactTitle);
    expect(screen.getByLabelText('Notes').props.value).toBe(exactNotes);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('keeps submitted values editable for retry when row detach aborts PATCH', async () => {
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const pendingPatch = deferred<AIActionDraftEnvelope>();
    let patchSignal: AbortSignal | undefined;
    mockGet.mockResolvedValueOnce({ draft: source });
    mockPatch.mockImplementationOnce(
      async (_tripId, _draftId, _payload, signal) => {
        patchSignal = signal;
        return pendingPatch.promise;
      },
    );
    const row = (visible: boolean) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={source}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true));
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    const exactTitle = '  Retry\n exact title  ';
    await fireEvent.changeText(screen.getByLabelText('Title'), exactTitle);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    expect(patchSignal?.aborted).toBe(false);

    await rendered.rerender(row(false));
    expect(patchSignal?.aborted).toBe(true);
    await rendered.rerender(row(true));

    expect(screen.getByTestId('ai-draft-field-editor')).toBeTruthy();
    expect(screen.getByLabelText('Title').props.value).toBe(exactTitle);
    expect(screen.getByLabelText('Title').props.editable).toBe(true);
    await act(async () => {
      pendingPatch.resolve({ draft: source });
      await pendingPatch.promise;
    });
  });

  it('clears a persisted editor when authority revokes editing or the room resource changes', async () => {
    const sourceA = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const revokedA = makeDraft({
      ...sourceA,
      can_edit: false,
      can_cancel: false,
    });
    const sourceB = editableDraft(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Draft B',
    );
    const coordinatorA = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const coordinatorB = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_B}`,
      tripId: TRIP_B,
    });
    const row = (
      coordinator: AIReconciliationCoordinator,
      tripId: string,
      draft: ReturnType<typeof makeDraft>,
    ) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={jest.fn()}
          tripId={tripId}
        />
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(coordinatorA, TRIP_A, sourceA));
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(
      screen.getByLabelText('Title'),
      'Must not cross authority',
    );

    await rendered.rerender(row(coordinatorA, TRIP_A, revokedA));
    expect(screen.queryByTestId('ai-draft-field-editor')).toBeNull();
    expect(screen.queryByText('Must not cross authority')).toBeNull();

    await rendered.rerender(row(coordinatorB, TRIP_B, sourceB));
    expect(screen.queryByTestId('ai-draft-field-editor')).toBeNull();
    expect(screen.queryByText('Must not cross authority')).toBeNull();
  });

  it('applies same-updated-at permission and authority revocation immediately', async () => {
    const initial = makeDraft();
    const rendered = await render(
      <AIActionDraftCardController
        draft={initial}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: 'Confirm this action' })).toBeTruthy();
    await rendered.rerender(
      <AIActionDraftCardController
        draft={makeDraft({
          can_confirm: false,
          can_cancel: false,
          can_edit: false,
          required_confirmation: 'TRANSFER_RECIPIENT',
        })}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await rendered.rerender(
      <AIActionDraftCardController
        draft={initial}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm this action' })).toBeNull();
  });

  it('joins an offscreen room reconciliation claim and surfaces its shared rejection without republishing', async () => {
    let rejectPublisher: (error: unknown) => void = () => undefined;
    const publisher = new Promise<null>((_resolve, reject) => {
      rejectPublisher = reject;
    });
    mockReconcile.mockReturnValueOnce(publisher);
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const confirmed = makeDraft({
      ...source,
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      result: { expense_id: 'expense-shared-failure' },
      updated_at: '2026-05-13T01:00:00.000Z',
    });
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user:${TRIP_A}`,
      tripId: TRIP_A,
      reconcile: mockReconcile,
    });
    const offscreenClaim = coordinator.reconcile({
      previousStatus: source.status,
      draft: confirmed,
    });
    void offscreenClaim.catch(() => undefined);
    const rendered = await render(
      <AIReconciliationCoordinatorProvider value={coordinator}>
        <AIActionDraftCardController
          draft={source}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />
      </AIReconciliationCoordinatorProvider>,
    );

    await rendered.rerender(
      <AIReconciliationCoordinatorProvider value={coordinator}>
        <AIActionDraftCardController
          draft={confirmed}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />
      </AIReconciliationCoordinatorProvider>,
    );
    await act(async () => {
      rejectPublisher(new Error('publisher failed'));
      await offscreenClaim.catch(() => undefined);
    });

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        'The action was confirmed, but another trip screen could not refresh automatically.',
      ),
    ).toBeTruthy();
  });

  it('disables and explains an editor that expires locally while open', async () => {
    const expiresAt = '2026-08-10T00:00:01.000Z';
    const draft = editableDraft('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft A');
    const rendered = await render(
      <AIActionDraftCardController
        draft={makeDraft({ ...draft, expires_at: expiresAt })}
        nowMs={Date.parse(expiresAt) - 1}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Unsaved title');
    await rendered.rerender(
      <AIActionDraftCardController
        draft={makeDraft({ ...draft, expires_at: expiresAt })}
        nowMs={Date.parse(expiresAt)}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    expect(screen.getByLabelText('Title').props.editable).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Save draft information' }).props.accessibilityState
        .disabled,
    ).toBe(true);
    expect(screen.getByText('This draft expired. Your edits were not applied.')).toBeTruthy();
  });

  it('retains the exact submitted edit when websocket expiry wins before PATCH settles', async () => {
    const draftId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const source = editableDraft(draftId, 'Draft A');
    const expired = makeDraft({
      ...source,
      status: 'EXPIRED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const pendingPatch = deferred<AIActionDraftEnvelope>();
    let patchSignal: AbortSignal | undefined;
    mockGet.mockResolvedValueOnce({ draft: source });
    mockPatch.mockImplementationOnce(
      async (_tripId, _draftId, _payload, signal) => {
        patchSignal = signal;
        return pendingPatch.promise;
      },
    );
    const rendered = await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    const exactSubmittedTitle = '  Do not trim\nthis value  ';
    await fireEvent.changeText(screen.getByLabelText('Title'), exactSubmittedTitle);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    await rendered.rerender(
      <AIActionDraftCardController
        draft={expired}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    expect(screen.getByLabelText('Draft status: Expired')).toBeTruthy();
    expect(patchSignal?.aborted).toBe(true);
    expect(screen.getByLabelText('Title').props.value).toBe(exactSubmittedTitle);
    expect(screen.getByLabelText('Title').props.editable).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Save draft information' }).props
        .accessibilityState.busy,
    ).toBe(false);
    expect(
      screen.getByText('This draft expired. Your edits were not applied.'),
    ).toBeTruthy();

    await act(async () => {
      pendingPatch.resolve({ draft: expired });
      await pendingPatch.promise;
    });
  });

  it('reconciles a websocket CONFIRMED transition exactly once before confirm HTTP settles', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const confirmed = makeDraft({
      ...source,
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const pendingConfirm = deferred<ReturnType<typeof createConfirmAmbiguityState>>();
    let confirmSignal: AbortSignal | undefined;
    mockGet.mockResolvedValueOnce({ draft: source });
    mockConfirm.mockImplementationOnce(async (options) => {
      confirmSignal = options.signal;
      return pendingConfirm.promise;
    });
    const rendered = await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    await rendered.rerender(
      <AIActionDraftCardController
        draft={confirmed}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await act(async () => Promise.resolve());
    expect(confirmSignal?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith({
      tripId: TRIP_A,
      previousStatus: 'READY',
      draft: confirmed,
    });

    await act(async () => {
      pendingConfirm.resolve(createConfirmAmbiguityState(confirmed));
      await pendingConfirm.promise;
    });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles a websocket CONFIRMED transition exactly once before cancel HTTP settles', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const confirmed = makeDraft({
      ...source,
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const pendingCancel = deferred<AIActionDraftEnvelope>();
    let cancelSignal: AbortSignal | undefined;
    mockGet.mockResolvedValueOnce({ draft: source });
    mockCancel.mockImplementationOnce(async (_tripId, _draftId, signal) => {
      cancelSignal = signal;
      return pendingCancel.promise;
    });
    const rendered = await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Cancel this draft' }),
    );
    await rendered.rerender(
      <AIActionDraftCardController
        draft={confirmed}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await act(async () => Promise.resolve());
    expect(cancelSignal?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(mockReconcile).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingCancel.resolve({ draft: confirmed });
      await pendingCancel.promise;
    });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('does not publish reconciliation when first mounted from confirmed history', async () => {
    const confirmed = makeDraft({
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
    });
    await render(
      <AIActionDraftCardController
        draft={confirmed}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await act(async () => Promise.resolve());
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it.each([
    ['confirm', 'can_confirm', 'Confirm', 'Confirm this action'],
    ['cancel', 'can_cancel', 'Cancel', 'Cancel this draft'],
  ] as const)(
    'preflights and stops %s when viewer authority is revoked without a row version change',
    async (_operation, permission, triggerLabel, explicitLabel) => {
      const source = readyDraft(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Draft A',
      );
      const revoked = makeDraft({ ...source, [permission]: false });
      mockGet.mockResolvedValueOnce({ draft: revoked });
      const changed = jest.fn();
      function Harness() {
        const [draft, setDraft] = useState(source);
        return (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={(next) => {
              changed(next);
              setDraft(next);
            }}
            tripId={TRIP_A}
          />
        );
      }
      await render(<Harness />);

      await fireEvent.press(screen.getByRole('button', { name: triggerLabel }));
      await fireEvent.press(screen.getByRole('button', { name: explicitLabel }));

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledWith(revoked);
      expect(screen.queryByRole('button', { name: triggerLabel })).toBeNull();
      expect(screen.queryByRole('button', { name: explicitLabel })).toBeNull();
    },
  );

  it('preflights and stops PATCH when can_edit is revoked without a row version change', async () => {
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const revoked = makeDraft({ ...source, can_edit: false });
    mockGet.mockResolvedValueOnce({ draft: revoked });
    const changed = jest.fn();
    function Harness() {
      const [draft, setDraft] = useState(source);
      return (
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={(next) => {
            changed(next);
            setDraft(next);
          }}
          tripId={TRIP_A}
        />
      );
    }
    await render(<Harness />);

    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Stale edit');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPatch).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith(revoked);
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
  });

  it('requires a fresh explicit confirmation when the server restatement changes during preflight', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const changedSummary = makeDraft({
      ...source,
      display: { ...source.display, title: 'Different expense' },
      summary: 'Create a materially different expense',
      preview: { title: 'Different expense', total_amount: '999' },
    });
    mockGet.mockResolvedValueOnce({ draft: changedSummary });
    const changed = jest.fn();
    function Harness() {
      const [draft, setDraft] = useState(source);
      return (
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={(next) => {
            changed(next);
            setDraft(next);
          }}
          tripId={TRIP_A}
        />
      );
    }
    await render(<Harness />);

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledWith(changedSummary);
    expect(screen.queryByRole('button', { name: 'Confirm this action' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      screen.getByText('Create expense “Different expense”.'),
    ).toBeTruthy();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('routes confirm-controller reconciliation through the same resource-scoped exact-once gate', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const confirmed = makeDraft({
      ...source,
      status: 'CONFIRMED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    mockGet.mockResolvedValueOnce({ draft: source });
    mockConfirm.mockImplementationOnce(async (options) => {
      const reconcile = options.dependencies?.reconcile;
      if (reconcile === undefined) {
        throw new Error('Expected injected confirm dependencies.');
      }
      await reconcile({
        tripId: TRIP_A,
        previousDraft: source,
        nextDraft: confirmed,
      });
      await reconcile({
        tripId: TRIP_A,
        previousDraft: source,
        nextDraft: confirmed,
      });
      return {
        ...createConfirmAmbiguityState(confirmed),
        kind: 'confirmed',
        observedConfirmed: true,
      };
    });
    function Harness() {
      const [draft, setDraft] = useState(source);
      return (
        <AIActionDraftCardController
          draft={draft}
          onDraftChanged={setDraft}
          tripId={TRIP_A}
        />
      );
    }
    await render(<Harness />);

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    await act(async () => Promise.resolve());

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Draft status: Confirmed')).toBeTruthy();
  });

  it('clears an old submitted edit when a non-expired authority snapshot advances before a later expiry', async () => {
    const source = editableDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const newer = makeDraft({
      ...source,
      display: { title: 'Newer draft', kicker: 'Expense' },
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const expired = makeDraft({
      ...newer,
      status: 'EXPIRED',
      can_confirm: false,
      can_cancel: false,
      can_edit: false,
      missing_fields: [],
      updated_at: '2026-05-13T00:20:00.000Z',
    });
    const pendingPatch = deferred<AIActionDraftEnvelope>();
    mockGet.mockResolvedValueOnce({ draft: source });
    mockPatch.mockReturnValueOnce(pendingPatch.promise);
    const rendered = await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Must be cleared');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    await rendered.rerender(
      <AIActionDraftCardController
        draft={newer}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await rendered.rerender(
      <AIActionDraftCardController
        draft={expired}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    expect(screen.getByLabelText('Draft status: Expired')).toBeTruthy();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(screen.queryByText('Must be cleared')).toBeNull();
    await act(async () => {
      pendingPatch.resolve({ draft: newer });
      await pendingPatch.promise;
    });
  });

  it('keeps modal focus return alive across the controller source boundary', async () => {
    jest.useFakeTimers();
    let unmount: (() => void | Promise<void>) | null = null;
    try {
      const source = readyDraft(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Draft A',
      );
      const confirmed = makeDraft({
        ...source,
        status: 'CONFIRMED',
        can_confirm: false,
        can_cancel: false,
        can_edit: false,
        updated_at: '2026-05-13T00:10:00.000Z',
      });
      const pendingConfirm = deferred<ReturnType<typeof createConfirmAmbiguityState>>();
      mockGet.mockResolvedValueOnce({ draft: source });
      mockConfirm.mockReturnValueOnce(pendingConfirm.promise);
      mockFocusAccessibilityNode.mockClear();
      const rendered = await render(
        <AIActionDraftCardController
          draft={source}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />,
      );
      unmount = rendered.unmount;
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      const modal = screen.getByTestId('ai-draft-confirm-modal');
      await act(async () => modal.props.onShow());
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm this action' }),
      );
      await rendered.rerender(
        <AIActionDraftCardController
          draft={confirmed}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />,
      );
      await act(async () => {
        modal.props.onDismiss();
        jest.runOnlyPendingTimers();
      });

      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(2);
      expect(mockFocusAccessibilityNode.mock.calls[1]?.[0]).not.toBeNull();
      await act(async () => {
        pendingConfirm.resolve(createConfirmAmbiguityState(confirmed));
        await pendingConfirm.promise;
      });
    } finally {
      await unmount?.();
      await act(async () => jest.runOnlyPendingTimers());
      jest.useRealTimers();
    }
  });

  it('keeps Check status only after a same-resource READY update aborts an in-flight confirm', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const newer = makeDraft({
      ...source,
      display: { title: 'Fresh draft', kicker: 'Expense' },
      updated_at: '2026-05-13T00:10:00.000Z',
    });
    const pendingConfirm = deferred<ReturnType<typeof createConfirmAmbiguityState>>();
    let confirmSignal: AbortSignal | undefined;
    mockGet.mockResolvedValueOnce({ draft: source });
    mockConfirm.mockImplementationOnce(async (options) => {
      confirmSignal = options.signal;
      return pendingConfirm.promise;
    });
    mockCheck.mockResolvedValueOnce({
      ...createConfirmAmbiguityState(newer),
      kind: 'ready_for_explicit_confirmation',
      message: 'The action is still ready. Review it again before confirming.',
    });
    const coordinator = createAIReconciliationCoordinator({
      resourceKey: `user-a:${TRIP_A}`,
      tripId: TRIP_A,
    });
    const row = (visible: boolean, draft: ReturnType<typeof makeDraft>) => (
      <AIReconciliationCoordinatorProvider value={coordinator}>
        {visible ? (
          <AIActionDraftCardController
            draft={draft}
            onDraftChanged={jest.fn()}
            tripId={TRIP_A}
          />
        ) : null}
      </AIReconciliationCoordinatorProvider>
    );
    const rendered = await render(row(true, source));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(confirmSignal?.aborted).toBe(false);

    await rendered.rerender(row(true, newer));

    expect(confirmSignal?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    await rendered.rerender(row(false, newer));
    await rendered.rerender(row(true, newer));
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Check status' }));
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      screen.getByRole('button', { name: 'Confirm this action' }),
    ).toBeTruthy();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingConfirm.resolve(createConfirmAmbiguityState(source));
      await pendingConfirm.promise;
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('preserves an already-unknown confirmation across newer nonterminal restatement and authority snapshots', async () => {
    const source = readyDraft(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Draft A',
    );
    const restated = makeDraft({
      ...source,
      display: { title: 'Fresh restatement', kicker: 'Expense' },
      summary: 'Fresh confirmation restatement',
    });
    const needsInfo = editableDraft(
      source.id,
      'Fresh permissions require more information',
    );
    const unknown = {
      ...createConfirmAmbiguityState(source),
      kind: 'unknown' as const,
      message: 'The confirmation outcome is unknown.',
      canCheckStatus: true,
    };
    mockGet.mockResolvedValueOnce({ draft: source });
    mockConfirm.mockResolvedValueOnce(unknown);
    const rendered = await render(
      <AIActionDraftCardController
        draft={source}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

    await rendered.rerender(
      <AIActionDraftCardController
        draft={restated}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );
    expect(screen.getByText('Fresh restatement')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();

    await rendered.rerender(
      <AIActionDraftCardController
        draft={needsInfo}
        onDraftChanged={jest.fn()}
        tripId={TRIP_A}
      />,
    );

    expect(
      screen.getByText('Fresh permissions require more information'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CONFIRMED', 'Confirmed'],
    ['CANCELLED', 'Cancelled'],
    ['EXPIRED', 'Expired'],
    ['FAILED', 'Failed'],
  ] as const)(
    'lets authoritative %s resolve an already-unknown confirmation',
    async (status, label) => {
      const source = readyDraft(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'Draft A',
      );
      const terminal = makeDraft({
        ...source,
        status,
        can_confirm: false,
        can_cancel: false,
        can_edit: false,
        updated_at: '2026-05-13T00:10:00.000Z',
      });
      mockGet.mockResolvedValueOnce({ draft: source });
      mockConfirm.mockResolvedValueOnce({
        ...createConfirmAmbiguityState(source),
        kind: 'unknown',
        message: 'The confirmation outcome is unknown.',
        canCheckStatus: true,
      });
      const rendered = await render(
        <AIActionDraftCardController
          draft={source}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />,
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm this action' }),
      );
      expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();

      await rendered.rerender(
        <AIActionDraftCardController
          draft={terminal}
          onDraftChanged={jest.fn()}
          tripId={TRIP_A}
        />,
      );

      expect(screen.getByLabelText(`Draft status: ${label}`)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
      expect(mockConfirm).toHaveBeenCalledTimes(1);
    },
  );
});
