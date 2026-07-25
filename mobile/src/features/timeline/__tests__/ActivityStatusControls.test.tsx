import { AxiosError, AxiosHeaders } from 'axios';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import {
  ActivityStatusControls,
  getActivityStatusActions,
} from '../components/ActivityStatusControls';
import type {
  TimelineActivity,
  TimelineActivityStatus,
} from '../types';
import type { ApiError } from '@/shared/api/errors';

function buildActivity(
  status: TimelineActivityStatus,
  {
    canEdit = false,
    canUpdateStatus = true,
  }: { canEdit?: boolean; canUpdateStatus?: boolean } = {},
): TimelineActivity {
  return {
    id: 'activity-1',
    title: 'Airport transfer',
    time_mode: 'AT_TIME',
    start_time: '09:00:00',
    end_time: null,
    status,
    position: 0,
    activity_type: null,
    assignee_scope: 'USER',
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
      can_edit: canEdit,
      can_delete: false,
      can_update_status: canUpdateStatus,
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function axiosErrorWith(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data,
  });
}

describe('getActivityStatusActions', () => {
  it.each([
    ['UPCOMING', ['IN_PROGRESS']],
    ['IN_PROGRESS', ['UPCOMING', 'DONE']],
    ['DONE', []],
    ['CANCELLED', []],
  ] as const)(
    'returns the base %s transition matrix without captain edit capability',
    (status, expected) => {
      expect(
        getActivityStatusActions(buildActivity(status)).map(
          (action) => action.status,
        ),
      ).toEqual(expected);
    },
  );

  it.each([
    ['UPCOMING', ['IN_PROGRESS', 'DONE', 'CANCELLED']],
    ['IN_PROGRESS', ['UPCOMING', 'DONE', 'CANCELLED']],
    ['DONE', ['IN_PROGRESS', 'UPCOMING', 'CANCELLED']],
    ['CANCELLED', ['UPCOMING']],
  ] as const)(
    'merges captain extras for %s in stable order without duplicates',
    (status, expected) => {
      const actions = getActivityStatusActions(
        buildActivity(status, { canEdit: true }),
      );
      expect(actions.map((action) => action.status)).toEqual(expected);
      expect(new Set(actions.map((action) => action.status)).size).toBe(
        actions.length,
      );
    },
  );

  it('returns no actions when per-activity status capability denies updates', () => {
    expect(
      getActivityStatusActions(
        buildActivity('UPCOMING', {
          canEdit: true,
          canUpdateStatus: false,
        }),
      ),
    ).toEqual([]);
  });
});

describe('ActivityStatusControls', () => {
  it('renders null unless the activity can update status', async () => {
    await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING', {
          canEdit: true,
          canUpdateStatus: false,
        })}
        onChangeStatus={jest.fn()}
      />,
    );

    expect(screen.queryByLabelText('Activity status controls')).toBeNull();
  });

  it('renders clear accessible labels in the matrix order', async () => {
    await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING', { canEdit: true })}
        onChangeStatus={jest.fn()}
      />,
    );

    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.props.accessibilityLabel),
    ).toEqual(['Start activity', 'Mark done', 'Cancel activity']);
  });

  it('honors an external mutation lock without calling the handler', async () => {
    const onChangeStatus = jest.fn().mockResolvedValue(undefined);
    await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING', { canEdit: true })}
        disabled
        onChangeStatus={onChangeStatus}
      />,
    );

    const start = screen.getByRole('button', { name: 'Start activity' });
    expect(start.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(start);
    expect(onChangeStatus).not.toHaveBeenCalled();
  });

  it('locks rapid presses across different transitions until the request settles', async () => {
    const pending = deferred<void>();
    const onChangeStatus = jest.fn(() => pending.promise);
    await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING', { canEdit: true })}
        onChangeStatus={onChangeStatus}
      />,
    );

    const [startPressable, , cancelPressable] =
      screen.getAllByTestId('button-pressable');
    await act(async () => {
      startPressable.props.onClick({});
      cancelPressable.props.onClick({});
    });

    expect(onChangeStatus).toHaveBeenCalledTimes(1);
    expect(onChangeStatus).toHaveBeenCalledWith('IN_PROGRESS');
    expect(
      screen.getByRole('button', { name: 'Start activity' }).props
        .accessibilityState,
    ).toMatchObject({ busy: true, disabled: true });
    expect(
      screen.getByRole('button', { name: 'Cancel activity' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: true });

    await act(async () => {
      pending.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Cancel activity' }).props
          .accessibilityState,
      ).toMatchObject({ disabled: false }),
    );
  });

  it('unlocks after success without displaying an error', async () => {
    const onChangeStatus = jest.fn().mockResolvedValue(undefined);
    await render(
      <ActivityStatusControls
        activity={buildActivity('IN_PROGRESS')}
        onChangeStatus={onChangeStatus}
      />,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Mark done' }),
    );
    await waitFor(() =>
      expect(onChangeStatus).toHaveBeenCalledWith('DONE'),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reset to upcoming' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: false, busy: false });
  });

  it('normalizes a rejection verbatim and notifies the reconciliation owner', async () => {
    const onSettledFailure = jest.fn();
    const onChangeStatus = jest.fn().mockRejectedValue(
      axiosErrorWith(409, {
        detail: 'This status transition is no longer allowed.',
        error_code: 'INVALID_STATUS_TRANSITION',
      }),
    );
    await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING')}
        onChangeStatus={onChangeStatus}
        onSettledFailure={onSettledFailure}
      />,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Start activity' }),
    );

    expect(
      await screen.findByText(
        'This status transition is no longer allowed.',
      ),
    ).toBeTruthy();
    expect(onSettledFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'This status transition is no longer allowed.',
        errorCode: 'INVALID_STATUS_TRANSITION',
        status: 409,
      }),
    );
  });

  it('renders an externally supplied error without replacing its ownership', async () => {
    const externalError: ApiError = {
      kind: 'message',
      message: 'Permission changed. Refresh the timeline.',
      status: 403,
    };
    await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING')}
        error={externalError}
        onChangeStatus={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(
      screen.getByText('Permission changed. Refresh the timeline.'),
    ).toBeTruthy();
  });

  it('does not update local state when a rejection settles after unmount', async () => {
    const pending = deferred<void>();
    const onSettledFailure = jest.fn();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const rendered = await render(
      <ActivityStatusControls
        activity={buildActivity('UPCOMING')}
        onChangeStatus={() => pending.promise}
        onSettledFailure={onSettledFailure}
      />,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Start activity' }),
    );
    await rendered.unmount();
    await act(async () => {
      pending.reject(new Error('Late failure.'));
    });

    expect(onSettledFailure).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
