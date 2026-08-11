import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { focusAccessibilityNode } from '../accessibilityFocus';
import { ActionDraftCard, type ActionDraftCardProps } from '../components/ActionDraftCard';
import type { AIActionDraftStatus } from '../drafts';
import { makeDraftFixture as makeDraft } from '../__fixtures__/drafts';

jest.mock('../accessibilityFocus', () => ({
  focusAccessibilityNode: jest.fn(),
}));

const mockFocusAccessibilityNode = jest.mocked(focusAccessibilityNode);

const NOW_MS = Date.parse('2026-08-10T00:00:00.000Z');

function callbacks() {
  return {
    onPatch: jest.fn(async () => undefined),
    onConfirm: jest.fn(async () => undefined),
    onCancel: jest.fn(async () => undefined),
    onCheckStatus: jest.fn(async () => undefined),
  };
}

async function renderCard(
  draft = makeDraft(),
  overrides: Partial<ActionDraftCardProps> = {},
) {
  const handlers = callbacks();
  await render(
    <ActionDraftCard
      draft={draft}
      nowMs={NOW_MS}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const STATUS_LABEL: Readonly<Record<AIActionDraftStatus, string>> = {
  NEEDS_INFO: 'Needs info',
  READY: 'Ready',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  FAILED: 'Failed',
};

describe('AI action draft card status shell', () => {
  it.each([
    'NEEDS_INFO',
    'READY',
    'CONFIRMED',
    'CANCELLED',
    'EXPIRED',
    'FAILED',
  ] as const)('renders the complete %s state', async (status) => {
    const isActive = status === 'READY' || status === 'NEEDS_INFO';
    await renderCard(
      makeDraft({
        status,
        can_confirm: status === 'READY',
        can_cancel: isActive,
        can_edit: status === 'NEEDS_INFO',
        missing_fields:
          status === 'NEEDS_INFO'
            ? [{ name: 'title', label: 'Title', required: true }]
            : [],
        result: status === 'CONFIRMED' ? { expense_id: 'expense-1' } : {},
        error_code: status === 'FAILED' ? 'AI_DRAFT_STALE' : '',
        error_detail: status === 'FAILED' ? 'The target changed.' : '',
      }),
    );
    expect(
      screen.getByLabelText(`Draft status: ${STATUS_LABEL[status]}`),
    ).toBeTruthy();
  });

  it('renders unknown actions through generic summary/preview and keeps server actions', async () => {
    await renderCard(
      makeDraft({
        action_type: 'future.teleport.create',
        required_confirmation: 'FUTURE_AUTHORITY',
        display: { title: 'Teleport everyone', kicker: 'Future action' },
        summary: 'Move everyone to Mars',
        preview: { destination: { planet: 'Mars' }, seats: 4 },
      }),
    );
    expect(screen.getByTestId('ai-generic-draft-details')).toBeTruthy();
    expect(screen.getByText('Move everyone to Mars')).toBeTruthy();
    expect(screen.getByText('{planet: Mars}')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('shows controls solely from can_confirm/can_cancel/can_edit', async () => {
    await renderCard(
      makeDraft({
        status: 'CANCELLED',
        can_confirm: true,
        can_cancel: false,
        can_edit: true,
        missing_fields: [{ name: 'title', label: 'Title' }],
      }),
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeTruthy();
  });

  it('reflects an expiry race locally while retaining disabled server-authorized controls', async () => {
    await renderCard(
      makeDraft({
        status: 'READY',
        can_confirm: true,
        can_cancel: true,
        expires_at: '2026-08-10T00:00:00.000Z',
      }),
    );
    expect(screen.getByLabelText('Draft status: Expired')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' }).props.accessibilityState.disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Cancel' }).props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('updates the visible expiry as time passes without a refetch', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW_MS);
    let unmount: (() => void | Promise<void>) | null = null;
    try {
      const rendered = await render(
        <ActionDraftCard
          draft={makeDraft({
            expires_at: '2026-08-10T00:00:01.000Z',
          })}
          {...callbacks()}
        />,
      );
      unmount = rendered.unmount;
      expect(screen.getByText('Expires in 1s')).toBeTruthy();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByLabelText('Draft status: Expired')).toBeTruthy();
      expect(screen.getByTestId('ai-draft-expiry').props.children).toBe('Expired');
    } finally {
      await unmount?.();
      jest.useRealTimers();
    }
  });
});

describe('AI action draft explicit mutation controls', () => {
  it('keeps server-authorized controls visible but disables every mutation entry while interaction is disabled', async () => {
    const draft = makeDraft({
      status: 'NEEDS_INFO',
      can_confirm: true,
      can_cancel: true,
      can_edit: true,
      missing_fields: [{ name: 'title', label: 'Title' }],
    });
    const handlers = await renderCard(draft, { interactionDisabled: true });

    for (const label of ['Edit draft', 'Cancel', 'Confirm']) {
      const control = screen.getByRole('button', { name: label });
      expect(control.props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(control);
    }
    expect(screen.queryByTestId('ai-draft-confirm-modal')).toBeNull();
    expect(screen.queryByTestId('ai-draft-cancel-modal')).toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(handlers.onPatch).not.toHaveBeenCalled();
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('keeps Check status visible but inert while interaction is disabled', async () => {
    const handlers = await renderCard(makeDraft(), {
      confirmOutcomeUnknown: true,
      interactionDisabled: true,
    });
    const check = screen.getByRole('button', { name: 'Check status' });
    expect(check.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(check);
    expect(handlers.onCheckStatus).not.toHaveBeenCalled();
  });

  it('requires a restatement before calling confirm', async () => {
    const handlers = await renderCard();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    const modal = screen.getByTestId('ai-draft-confirm-modal');
    expect(modal.props.presentationStyle).toBe('formSheet');
    expect(screen.getByTestId('ai-draft-confirm-modal-content').props.accessibilityViewIsModal).toBe(
      true,
    );
    expect(screen.getByText(/Create expense “Dinner” for 1,200,000 VND/)).toBeTruthy();
    expect(screen.getByText('The server requires an active trip captain.')).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(handlers.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('restates timeline date, time, and location before explicit confirmation', async () => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.create',
        display: { title: 'QA sunset walk', kicker: 'Activity' },
        preview: {
          section_date: '2026-08-11',
          data: {
            title: 'QA sunset walk',
            start_time: '18:00',
            end_time: '20:00',
            location_label: 'Da Nang',
          },
        },
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    const restatement = screen.getByText(
      'Create timeline activity “QA sunset walk”. Date: 2026-08-11. Time: 18:00 – 20:00. Location: Da Nang.',
    );
    expect(restatement.props.numberOfLines).toBeUndefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('restates the authoritative target and resolved end-time-only update', async () => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.update',
        display: {
          title: 'Old stop',
          kicker: 'Update activity',
          meta: [
            { label: 'Target', value: 'Old stop' },
            { label: 'Date', value: 'Day 1 · 2026-08-11' },
            { label: 'Time', value: '08:00 – 10:00' },
            { label: 'Location', value: 'Old Quarter' },
          ],
        },
        preview: {
          activity_id: '33333333-3333-4333-8333-333333333333',
          data: { end_time: '10:00:00' },
          target_title: 'Old stop',
          section_label: 'Day 1',
          section_date: '2026-08-11',
          resolved_data: {
            title: 'Old stop',
            time_mode: 'TIME_RANGE',
            start_time: '08:00:00',
            end_time: '10:00:00',
            location_label: 'Old Quarter',
          },
        },
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      screen.getByText(
        'Update timeline activity “Old stop”. Date: Day 1 · 2026-08-11. Time: 08:00 – 10:00. Location: Old Quarter.',
      ),
    ).toBeTruthy();
  });

  it('restates every allowlisted hidden timeline delta as inert text', async () => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.create',
        display: {
          title: 'Hidden detail review',
          kicker: 'Activity',
          meta: [
            { label: 'Date', value: 'Day 1 · 2026-08-11' },
            { label: 'Time', value: '09:00' },
            { label: 'Location', value: 'Not set' },
            { label: 'Custom type', value: 'Photo walk' },
            { label: 'Assignee', value: 'Lan Nguyen' },
            { label: 'Booking reference', value: 'BK-42' },
            { label: 'Contact name', value: 'Lan' },
            { label: 'Contact phone', value: '+84 123' },
            { label: 'External link', value: 'https://example.com/booking' },
            { label: 'Location note', value: 'Use the east entrance' },
            { label: 'Meeting point', value: 'Hotel lobby' },
            { label: 'Note', value: 'Bring water' },
            { label: 'Reminders', value: '1 day before · 30 minutes before' },
            { label: 'Internal precondition', value: 'must-not-render' },
          ],
        },
        preview: {
          section_label: 'Day 1',
          section_date: '2026-08-11',
          data: { custom_type_id: 'hidden-uuid' },
          resolved_data: {
            title: 'Hidden detail review',
            custom_type_label: 'Photo walk',
            time_mode: 'AT_TIME',
            start_time: '09:00:00',
          },
        },
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    const modal = within(screen.getByTestId('ai-draft-confirm-modal-content'));
    const restatement = modal.getByText(/Custom type: Photo walk\./);
    expect(restatement).toBeTruthy();
    expect(modal.getByText(/Assignee: Lan Nguyen\./)).toBeTruthy();
    expect(modal.getByText(/Booking reference: BK-42\./)).toBeTruthy();
    expect(modal.getByText(/Contact name: Lan\./)).toBeTruthy();
    expect(modal.getByText(/Contact phone: \+84 123\./)).toBeTruthy();
    expect(
      modal.getByText(/External link: https:\/\/example\.com\/booking\./),
    ).toBeTruthy();
    expect(modal.getByText(/Location note: Use the east entrance\./)).toBeTruthy();
    expect(modal.getByText(/Meeting point: Hotel lobby\./)).toBeTruthy();
    expect(modal.getByText(/Note: Bring water\./)).toBeTruthy();
    expect(
      modal.getByText(/Reminders: 1 day before · 30 minutes before\./),
    ).toBeTruthy();
    expect(modal.queryByText(/must-not-render/)).toBeNull();
    expect(modal.queryByText(/hidden-uuid/)).toBeNull();
    expect(modal.queryByRole('link')).toBeNull();
  });

  it('restates explicit hidden clears while omitting missing deltas', async () => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.update',
        display: {
          title: 'Clear hidden details',
          kicker: 'Update activity',
          meta: [
            { label: 'Target', value: 'Clear hidden details' },
            { label: 'Date', value: 'Day 1 · 2026-08-11' },
            { label: 'Time', value: 'Flexible' },
            { label: 'Location', value: 'Not set' },
            { label: 'Contact name', value: 'Cleared' },
            { label: 'External link', value: 'Cleared' },
            { label: 'Note', value: 'Cleared' },
            { label: 'Reminders', value: 'Cleared' },
          ],
        },
        preview: {
          target_title: 'Clear hidden details',
          data: {
            contact_name: '',
            external_link: '',
            note: '',
            reminder_offsets_minutes: [],
          },
          resolved_data: {
            title: 'Clear hidden details',
            time_mode: 'FLEXIBLE',
          },
        },
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    const modal = within(screen.getByTestId('ai-draft-confirm-modal-content'));
    expect(modal.getByText(/Contact name: Cleared\./)).toBeTruthy();
    expect(modal.getByText(/External link: Cleared\./)).toBeTruthy();
    expect(modal.getByText(/Note: Cleared\./)).toBeTruthy();
    expect(modal.getByText(/Reminders: Cleared\./)).toBeTruthy();
    expect(modal.queryByText(/Booking reference:/)).toBeNull();
  });

  it.each([
    ['preserved', 'Riverside Cafe'],
    ['cleared', 'Cleared'],
    ['not set', 'Not set'],
  ] as const)('restates a %s timeline location explicitly', async (_, location) => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.update',
        display: {
          title: 'Cafe stop',
          kicker: 'Update activity',
          meta: [
            { label: 'Target', value: 'Cafe stop' },
            { label: 'Date', value: 'Day 1 · 2026-08-11' },
            { label: 'Time', value: 'Flexible' },
            { label: 'Location', value: location },
          ],
        },
        preview: {
          data: location === 'Cleared' ? { location_label: '' } : { note: 'Note' },
          target_title: 'Cafe stop',
          resolved_data: {
            title: 'Cafe stop',
            time_mode: 'FLEXIBLE',
            location_label:
              location === 'Riverside Cafe' ? 'Riverside Cafe' : '',
          },
        },
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByText(new RegExp(`Location: ${location}\\.`))).toBeTruthy();
  });

  it('keeps malformed timeline context inert and does not bypass confirmation', async () => {
    const handlers = await renderCard(
      makeDraft({
        action_type: 'timeline.activity.update',
        display: {
          title: 'Safe target',
          kicker: 'Update activity',
          meta: [
            { label: 'Target', value: { href: 'https://malicious.example' } },
            { label: 'Date', value: ['not', 'trusted'] },
            { label: 'Time', value: { onPress: 'confirm' } },
            { label: 'Location', value: null },
          ],
        },
        preview: {
          target_title: { href: 'https://malicious.example' },
          resolved_data: {
            title: { onPress: 'confirm' },
            start_time: ['08:00'],
            place: { title: { href: 'https://malicious.example' } },
          },
        },
      }),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByText('Update timeline activity “Safe target”.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/malicious\.example/)).toBeNull();
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it('dismisses the native confirmation review without executing it', async () => {
    const handlers = await renderCard();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    const modal = screen.getByTestId('ai-draft-confirm-modal');
    await act(async () => {
      modal.props.onRequestClose();
    });
    expect(screen.queryByTestId('ai-draft-confirm-modal')).toBeNull();
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it('moves VoiceOver focus into the modal and returns it to the trigger on close', async () => {
    jest.useFakeTimers();
    try {
      mockFocusAccessibilityNode.mockClear();
      await renderCard();
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      const modal = screen.getByTestId('ai-draft-confirm-modal');
      await act(async () => {
        modal.props.onShow();
      });
      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(1);
      await fireEvent.press(
        screen.getByRole('button', { name: 'Back to review' }),
      );
      await act(async () => {
        modal.props.onDismiss();
        jest.runOnlyPendingTimers();
      });
      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns VoiceOver focus exactly once to a surviving status target when a fast terminal update removes the trigger', async () => {
    jest.useFakeTimers();
    let unmount: (() => void | Promise<void>) | null = null;
    try {
      mockFocusAccessibilityNode.mockClear();
      const source = makeDraft();
      const handlers = callbacks();
      const rendered = await render(
        <ActionDraftCard draft={source} nowMs={NOW_MS} {...handlers} />,
      );
      unmount = rendered.unmount;
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      const modal = screen.getByTestId('ai-draft-confirm-modal');
      await act(async () => {
        modal.props.onShow();
      });
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm this action' }),
      );
      await rendered.rerender(
        <ActionDraftCard
          draft={makeDraft({
            ...source,
            status: 'CONFIRMED',
            can_confirm: false,
            can_cancel: false,
            can_edit: false,
          })}
          nowMs={NOW_MS}
          {...handlers}
        />,
      );
      await act(async () => {
        modal.props.onDismiss();
        jest.runOnlyPendingTimers();
      });

      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(2);
      expect(mockFocusAccessibilityNode.mock.calls[1]?.[0]).not.toBeNull();
    } finally {
      await unmount?.();
      await act(async () => {
        jest.runOnlyPendingTimers();
      });
      jest.useRealTimers();
    }
  });

  it('moves focus to stable status when terminal state arrives after modal dismissal focused a disappearing trigger', async () => {
    jest.useFakeTimers();
    try {
      mockFocusAccessibilityNode.mockClear();
      const source = makeDraft();
      const handlers = callbacks();
      const rendered = await render(
        <ActionDraftCard draft={source} nowMs={NOW_MS} {...handlers} />,
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      const modal = screen.getByTestId('ai-draft-confirm-modal');
      await act(async () => {
        modal.props.onShow();
      });
      await fireEvent.press(
        screen.getByRole('button', { name: 'Confirm this action' }),
      );
      await act(async () => {
        modal.props.onDismiss();
        jest.runOnlyPendingTimers();
      });
      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(2);

      await rendered.rerender(
        <ActionDraftCard
          draft={makeDraft({
            ...source,
            status: 'CONFIRMED',
            can_confirm: false,
            can_cancel: false,
            can_edit: false,
          })}
          nowMs={NOW_MS}
          {...handlers}
        />,
      );
      await act(async () => {
        jest.runOnlyPendingTimers();
      });

      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(3);
      expect(mockFocusAccessibilityNode.mock.calls[2]?.[0]).not.toBeNull();
      await rendered.unmount();
    } finally {
      await act(async () => {
        jest.runOnlyPendingTimers();
      });
      jest.useRealTimers();
    }
  });

  it('cleans a pending modal focus return when the card unmounts', async () => {
    jest.useFakeTimers();
    try {
      mockFocusAccessibilityNode.mockClear();
      const rendered = await render(
        <ActionDraftCard draft={makeDraft()} nowMs={NOW_MS} {...callbacks()} />,
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      const modal = screen.getByTestId('ai-draft-confirm-modal');
      await act(async () => {
        modal.props.onShow();
      });
      await fireEvent.press(
        screen.getByRole('button', { name: 'Back to review' }),
      );
      await rendered.unmount();
      await act(async () => {
        jest.runOnlyPendingTimers();
      });
      expect(mockFocusAccessibilityNode).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('locks the explicit confirm callback against rapid duplicate presses', async () => {
    let release: () => void = () => undefined;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await renderCard(makeDraft(), { onConfirm });
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    const explicit = screen.getByRole('button', { name: 'Confirm this action' });
    await fireEvent.press(explicit);
    await fireEvent.press(explicit);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
    await act(async () => Promise.resolve());
  });

  it('does not let stale action cleanup release the lock owned by a newer source action', async () => {
    jest.useFakeTimers();
    let releaseOld: () => void = () => undefined;
    let releaseNew: () => void = () => undefined;
    let oldOperation = Promise.resolve();
    let newOperation = Promise.resolve();
    const onCancel = jest
      .fn<Promise<void>, Parameters<ActionDraftCardProps['onCancel']>>()
      .mockImplementationOnce(
        () => {
          oldOperation = new Promise<void>((resolve) => {
            releaseOld = resolve;
          });
          return oldOperation;
        },
      )
      .mockImplementationOnce(
        () => {
          newOperation = new Promise<void>((resolve) => {
            releaseNew = resolve;
          });
          return newOperation;
        },
      );
    const source = makeDraft();
    const rendered = await render(
      <ActionDraftCard
        draft={source}
        nowMs={NOW_MS}
        {...callbacks()}
        onCancel={onCancel}
      />,
    );
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      await fireEvent.press(
        screen.getByRole('button', { name: 'Cancel this draft' }),
      );

      await rendered.rerender(
        <ActionDraftCard
          draft={makeDraft({
            ...source,
            updated_at: '2026-08-10T00:01:00.000Z',
          })}
          nowMs={NOW_MS}
          {...callbacks()}
          onCancel={onCancel}
        />,
      );
      await act(async () => Promise.resolve());
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      const currentAction = screen.getByRole('button', {
        name: 'Cancel this draft',
      });
      await fireEvent.press(currentAction);
      expect(onCancel).toHaveBeenCalledTimes(2);

      await act(async () => {
        releaseOld();
        await oldOperation;
        await Promise.resolve();
        await Promise.resolve();
      });
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      await fireEvent.press(
        screen.getByRole('button', { name: 'Cancel this draft' }),
      );
      expect(onCancel).toHaveBeenCalledTimes(2);

      await act(async () => {
        releaseNew();
        await newOperation;
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      await rendered.unmount();
      await act(async () => {
        jest.runOnlyPendingTimers();
      });
      jest.useRealTimers();
    }
  });

  it('disables an already-open explicit review when a Retry-After deadline arrives', async () => {
    const handlers = callbacks();
    const draft = makeDraft();
    const rendered = await render(
      <ActionDraftCard draft={draft} nowMs={NOW_MS} {...handlers} />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await rendered.rerender(
      <ActionDraftCard
        confirmRetryAtMs={NOW_MS + 30_000}
        draft={draft}
        nowMs={NOW_MS}
        {...handlers}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Confirm this action' }).props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        'Confirmation available in 30s. Close this review and wait before confirming.',
      ),
    ).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Confirm this action' }),
    );
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it('requires a separate cancel confirmation', async () => {
    const handlers = await renderCard();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-draft-cancel-modal').props.presentationStyle).toBe(
      'formSheet',
    );
    expect(screen.getByTestId('ai-draft-cancel-modal-content').props.accessibilityViewIsModal).toBe(
      true,
    );
    expect(screen.getByText(/will not change trip data/)).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Cancel this draft' }),
    );
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('unknown confirmation state offers Check status and no Retry confirm', async () => {
    const handlers = await renderCard(makeDraft(), {
      confirmOutcomeUnknown: true,
    });
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry confirm/ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Check status' }));
    expect(handlers.onCheckStatus).toHaveBeenCalledTimes(1);
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it('closes an open confirm review when the outcome becomes unknown', async () => {
    const handlers = callbacks();
    const draft = makeDraft();
    const rendered = await render(
      <ActionDraftCard draft={draft} nowMs={NOW_MS} {...handlers} />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: 'Confirm this action' })).toBeTruthy();
    await rendered.rerender(
      <ActionDraftCard
        confirmOutcomeUnknown
        draft={draft}
        nowMs={NOW_MS}
        {...handlers}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm this action' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Check status' })).toHaveLength(1);
  });

  it('sends only fields the user edited from the inline editor', async () => {
    const draft = makeDraft({
      status: 'NEEDS_INFO',
      can_confirm: false,
      can_cancel: true,
      can_edit: true,
      missing_fields: [
        { name: 'title', label: 'Title' },
        { name: 'total_amount', label: 'Amount', type: 'money' },
      ],
    });
    const handlers = await renderCard(draft);
    await fireEvent.press(screen.getByRole('button', { name: 'Edit draft' }));
    await fireEvent.changeText(screen.getByLabelText('Title'), 'Lunch');
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save draft information' }),
    );
    expect(handlers.onPatch).toHaveBeenCalledWith(
      draft,
      { title: 'Lunch' },
      {
        fields: draft.missing_fields,
        values: { title: 'Lunch' },
      },
    );
  });
});

describe('specialized draft renderers at narrow width and Dynamic Type', () => {
  it('renders timeline section/date/time/type/location/assignee without ellipsis', async () => {
    const date = '2026-12-31 — New Year’s Eve';
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.create',
        display: { title: 'A deliberately long museum visit', kicker: 'Activity' },
        preview: {
          section_label: 'Day 12 — Historic district',
          section_date: date,
          data: {
            title: 'A deliberately long museum visit',
            start_time: '08:30',
            end_time: '11:45',
            system_type: 'SIGHTSEEING',
            location_label: 'The exceptionally long National History Museum address',
            assignee_scope: 'EVERYONE',
          },
        },
      }),
    );
    const dateText = screen.getByText(date);
    expect(dateText.props.numberOfLines).toBeUndefined();
    expect(dateText.props.ellipsizeMode).toBeUndefined();
    expect(screen.getByText('08:30 – 11:45')).toBeTruthy();
    expect(screen.getByText('Sightseeing')).toBeTruthy();
    expect(screen.getByText('Whole group')).toBeTruthy();
  });

  it('never renders a raw timeline section UUID as user-facing context', async () => {
    const sectionId = '77777777-7777-4777-8777-777777777777';
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.create',
        display: { title: 'Private section reference', kicker: 'Activity' },
        preview: {
          section_id: sectionId,
          resolved_data: {
            title: 'Private section reference',
            time_mode: 'FLEXIBLE',
          },
        },
      }),
    );

    expect(screen.queryByText(sectionId)).toBeNull();
  });

  it('omits a blank current timeline external link', async () => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.update',
        display: { title: 'No booking link', kicker: 'Update activity' },
        preview: {
          resolved_data: {
            title: 'No booking link',
            time_mode: 'FLEXIBLE',
            external_link: '',
          },
        },
      }),
    );

    expect(screen.queryByText('External link')).toBeNull();
    expect(screen.queryByText(/^Link \(text only\):/)).toBeNull();
  });

  it('renders an explicit external-link clear only through display metadata', async () => {
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.update',
        display: {
          title: 'Clear booking link',
          kicker: 'Update activity',
          meta: [{ label: 'External link', value: 'Cleared' }],
        },
        preview: {
          data: { external_link: '' },
          resolved_data: {
            title: 'Clear booking link',
            time_mode: 'FLEXIBLE',
            external_link: '',
          },
        },
      }),
    );

    expect(screen.getAllByText('External link')).toHaveLength(1);
    expect(screen.getAllByText('Cleared')).toHaveLength(1);
    expect(screen.queryByText(/^Link \(text only\):/)).toBeNull();
  });

  it('keeps a non-empty external link as unique inert text', async () => {
    const externalLink = 'https://example.com/reservation';
    await renderCard(
      makeDraft({
        action_type: 'timeline.activity.create',
        display: { title: 'Booking link', kicker: 'Activity' },
        preview: {
          resolved_data: {
            title: 'Booking link',
            time_mode: 'FLEXIBLE',
            external_link: externalLink,
          },
        },
      }),
    );

    expect(screen.getByText(`Link (text only): ${externalLink}`)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders full expense money/payer/participants/split with scalable wrapping styles', async () => {
    const amount = '123,456,789,012,345.67';
    await renderCard(
      makeDraft({
        display: {
          title: 'Shared expedition dinner',
          kicker: 'Expense',
          hero: { kind: 'amount', value: amount, currency: 'VND' },
        },
        preview: {
          payer_name: 'A payer with a very long display name',
          participants: ['Lan', 'Minh', 'An', 'Binh'],
          split_method: 'Exact amounts per participant',
        },
      }),
    );
    const amountText = screen.getByText(amount);
    expect(amountText.props.numberOfLines).toBeUndefined();
    expect(amountText.props.ellipsizeMode).toBeUndefined();
    expect(amountText.props.allowFontScaling).toBeUndefined();
    expect(StyleSheet.flatten(amountText.props.style)).toMatchObject({
      flexShrink: 1,
    });
    expect(screen.getByText('A payer with a very long display name')).toBeTruthy();
    expect(screen.getByText('[Lan, Minh, An, Binh]')).toBeTruthy();
    expect(screen.getByText('Exact amounts per participant')).toBeTruthy();
  });

  it('states settlement and transfer consequences plainly', async () => {
    const { rerender } = await render(
      <ActionDraftCard
        draft={makeDraft({
          action_type: 'settlement.finalize',
          display: { title: 'Finalize settlement', kicker: 'Settlement' },
        })}
        nowMs={NOW_MS}
        {...callbacks()}
      />,
    );
    expect(screen.getByText(/locks the current settlement calculation/)).toBeTruthy();
    await rerender(
      <ActionDraftCard
        draft={makeDraft({
          action_type: 'settlement.transfer.confirm_received',
          display: {
            title: 'Transfer',
            kicker: 'Transfer',
            hero: { kind: 'amount', value: '999999999999', currency: 'USD' },
            meta: [
              { label: 'From', value: 'Minh' },
              { label: 'To', value: 'Lan' },
            ],
          },
        })}
        nowMs={NOW_MS}
        {...callbacks()}
      />,
    );
    expect(screen.getByText('Minh → Lan')).toBeTruthy();
    expect(screen.getByText(/recipient is asserting.*received/)).toBeTruthy();
  });

  it('uses 100% card width, wrapping controls, 44pt targets, and explicit labels', async () => {
    await renderCard();
    expect(
      StyleSheet.flatten(
        screen.getByTestId(
          'ai-action-draft-22222222-2222-4222-8222-222222222222',
        ).props.style,
      ),
    ).toMatchObject({ width: '100%', minWidth: 0 });
    expect(
      StyleSheet.flatten(screen.getByTestId('ai-draft-actions').props.style),
    ).toMatchObject({ flexWrap: 'wrap' });
    for (const label of ['Confirm', 'Cancel']) {
      expect(
        StyleSheet.flatten(screen.getByRole('button', { name: label }).props.style),
      ).toMatchObject({ minWidth: 44, minHeight: 44 });
    }
  });

});
