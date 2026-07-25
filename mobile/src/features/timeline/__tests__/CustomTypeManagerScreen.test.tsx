import type { ReactNode } from 'react';
import { Alert, View } from 'react-native';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = { dismissTo: jest.fn() };
const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();
const mockUseTimeline = jest.fn();
const mockRefresh = jest.fn();
const mockInvalidate = jest.fn();
const mockPublishTimelineEvent = jest.fn();
const mockSubscribeToTimelineEvents = jest.fn();
let mockTimelineListener:
  | ((event: { type: 'timelineChanged'; tripId: string }) =>
      void | Promise<void>)
  | undefined;
let mockLatestStackOptions:
  | {
      gestureEnabled?: boolean;
      headerLeft?: () => ReactNode;
    }
  | undefined;

function mockRenderStackScreen({
  options,
}: {
  options: {
    gestureEnabled?: boolean;
    headerLeft?: () => ReactNode;
  };
}) {
  mockLatestStackOptions = options;
  return <View>{options.headerLeft?.()}</View>;
}

jest.mock('expo-router', () => ({
  Stack: { Screen: mockRenderStackScreen },
  useFocusEffect: (effect: () => (() => void) | void) =>
    mockUseFocusEffect(effect),
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/shared/hooks/useAppForegroundEffect', () => ({
  useAppForegroundEffect: (listener: () => void) =>
    mockUseAppForegroundEffect(listener),
}));
jest.mock('../hooks/useTimeline', () => ({
  useTimeline: (...args: unknown[]) => mockUseTimeline(...args),
}));
jest.mock('../api', () => ({
  createCustomType: jest.fn(),
  patchCustomType: jest.fn(),
  deleteCustomType: jest.fn(),
}));
jest.mock('../timelineEvents', () => ({
  publishTimelineEvent: (...args: unknown[]) =>
    mockPublishTimelineEvent(...args),
  subscribeToTimelineEvents: (...args: unknown[]) =>
    mockSubscribeToTimelineEvents(...args),
}));

// eslint-disable-next-line import/first
import { AxiosError, AxiosHeaders } from 'axios';
// eslint-disable-next-line import/first
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import {
  createCustomType,
  deleteCustomType,
  patchCustomType,
} from '../api';
// eslint-disable-next-line import/first
import { CustomTypeManagerScreen } from '../screens/CustomTypeManagerScreen';
// eslint-disable-next-line import/first
import type {
  TimelineCustomTypeMeta,
  TimelineResponse,
} from '../types';

const mockCreateCustomType = createCustomType as jest.MockedFunction<
  typeof createCustomType
>;
const mockPatchCustomType = patchCustomType as jest.MockedFunction<
  typeof patchCustomType
>;
const mockDeleteCustomType = deleteCustomType as jest.MockedFunction<
  typeof deleteCustomType
>;
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const ACTIVE_TYPE_ID = 'ec5945d1-0025-4c4b-af6c-21e49cfce949';
const INACTIVE_TYPE_ID = 'c2efc0e2-33ca-4a60-9690-88fbd438476f';
const UNKNOWN_TYPE_ID = '345232e3-eed9-4919-aec3-4988531ab625';

const activeType: TimelineCustomTypeMeta = {
  id: ACTIVE_TYPE_ID,
  name: 'Coffee',
  normalized_name: 'coffee',
  color_token: 'amber',
  icon_key: 'utensils',
  is_active: true,
};

const inactiveType: TimelineCustomTypeMeta = {
  id: INACTIVE_TYPE_ID,
  name: 'Relax',
  normalized_name: 'relax',
  color_token: 'teal',
  icon_key: 'smile',
  is_active: false,
};

const unknownType: TimelineCustomTypeMeta = {
  id: UNKNOWN_TYPE_ID,
  name: 'Legacy',
  normalized_name: 'legacy',
  color_token: 'brand-gold',
  icon_key: 'rocket',
  is_active: true,
};

function timeline(
  canManageCustomTypes = true,
): TimelineResponse {
  return {
    trip_timezone: 'Asia/Ho_Chi_Minh',
    permissions: {
      can_edit_timeline: canManageCustomTypes,
      can_manage_custom_types: canManageCustomTypes,
      can_create_sections: canManageCustomTypes,
    },
    system_types: [],
    custom_types: [activeType, inactiveType, unknownType],
    sections: [],
  };
}

function readyHook(nextTimeline = timeline()) {
  return {
    timeline: nextTimeline,
    status: 'ready' as const,
    error: null,
    refreshing: false,
    refresh: mockRefresh,
    invalidate: mockInvalidate,
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

function latestFocusCallback(): () => (() => void) | void {
  const callback = mockUseFocusEffect.mock.calls.at(-1)?.[0] as
    | (() => (() => void) | void)
    | undefined;
  if (!callback) {
    throw new Error('Expected useFocusEffect to register a callback.');
  }
  return callback;
}

async function focusScreen(): Promise<(() => void) | undefined> {
  let cleanup: (() => void) | undefined;
  await act(async () => {
    cleanup = latestFocusCallback()() || undefined;
  });
  return cleanup;
}

function destructiveAlertAction() {
  const buttons = mockAlert.mock.calls.at(-1)?.[2];
  const action = buttons?.find((button) => button.style === 'destructive');
  if (!action?.onPress) {
    throw new Error('Expected a destructive alert action.');
  }
  return action.onPress;
}

describe('CustomTypeManagerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { tripId: TRIP_ID };
    mockTimelineListener = undefined;
    mockLatestStackOptions = undefined;
    mockRefresh.mockResolvedValue(undefined);
    mockUseTimeline.mockReturnValue(readyHook());
    mockCreateCustomType.mockResolvedValue({
      ...activeType,
      id: 'cb938507-5c32-460f-9707-651756b3e96f',
    });
    mockPatchCustomType.mockResolvedValue(activeType);
    mockDeleteCustomType.mockResolvedValue(undefined);
    mockSubscribeToTimelineEvents.mockImplementation(
      (
        _tripId: string,
        listener: (
          event: { type: 'timelineChanged'; tripId: string },
        ) => void | Promise<void>,
      ) => {
        mockTimelineListener = listener;
        return jest.fn();
      },
    );
    mockPublishTimelineEvent.mockImplementation(
      async (event: { type: 'timelineChanged'; tripId: string }) => {
        await mockTimelineListener?.(event);
      },
    );
  });

  it('rejects malformed trip routes before loading or mutating', async () => {
    mockParams = { tripId: [TRIP_ID] };

    await render(<CustomTypeManagerScreen />);

    expect(screen.getByText('Custom types unavailable')).toBeTruthy();
    expect(mockUseTimeline).not.toHaveBeenCalled();
    expect(mockCreateCustomType).not.toHaveBeenCalled();
    expect(mockPatchCustomType).not.toHaveBeenCalled();
    expect(mockDeleteCustomType).not.toHaveBeenCalled();
  });

  it('gates direct links with aggregate custom-type authority', async () => {
    mockUseTimeline.mockReturnValue(readyHook(timeline(false)));

    await render(<CustomTypeManagerScreen />);

    expect(
      screen.getByText(
        'You do not have permission to manage custom activity types.',
      ),
    ).toBeTruthy();
    expect(mockUseTimeline).toHaveBeenCalledWith(TRIP_ID, {
      autoReconcile: false,
    });
    expect(
      screen.queryByTestId('custom-type-manager-list'),
    ).toBeNull();
  });

  it('keeps active, inactive, and unknown-token types visible and manageable', async () => {
    await render(<CustomTypeManagerScreen />);

    expect(screen.getByText('Coffee')).toBeTruthy();
    expect(screen.getByText('Relax')).toBeTruthy();
    expect(screen.getByText('Legacy')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Activate Relax' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Edit Legacy' }),
    ).toBeTruthy();
  });

  it('creates from finite picker values with a global ref lock and one event-owned reconcile', async () => {
    const pending = deferred<TimelineCustomTypeMeta>();
    mockCreateCustomType.mockReturnValue(pending.promise);
    await render(<CustomTypeManagerScreen />);
    await focusScreen();
    mockRefresh.mockClear();

    await fireEvent.changeText(
      screen.getByLabelText('New custom type name'),
      '  Dinner stop  ',
    );
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'New custom type color Rose',
      }),
    );
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'New custom type icon Sightseeing',
      }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add custom type' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add custom type' }),
    );

    await waitFor(() =>
      expect(mockCreateCustomType).toHaveBeenCalledTimes(1),
    );
    expect(mockCreateCustomType).toHaveBeenCalledWith(TRIP_ID, {
      name: 'Dinner stop',
      color_token: 'rose',
      icon_key: 'camera',
    });
    expect(mockLatestStackOptions?.gestureEnabled).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Close custom types' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: true });

    await act(async () => {
      pending.resolve({
        ...activeType,
        id: 'cb938507-5c32-460f-9707-651756b3e96f',
        name: 'Dinner stop',
        normalized_name: 'dinner-stop',
        color_token: 'rose',
        icon_key: 'camera',
      });
    });

    expect(await screen.findByText('Custom type created.')).toBeTruthy();
    expect(
      screen.getByLabelText('New custom type name').props.value,
    ).toBe('');
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith('silent');
    expect(mockInvalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateCustomType.mock.invocationCallOrder[0]!,
    );
    expect(mockCreateCustomType.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishTimelineEvent.mock.invocationCallOrder[0]!,
    );
  });

  it('renames with a minimal PATCH while preserving unknown raw tokens', async () => {
    await render(<CustomTypeManagerScreen />);
    await focusScreen();
    mockRefresh.mockClear();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Edit Legacy' }),
    );

    expect(
      screen.getByText(/Current unsupported color token: brand-gold/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Current unsupported icon key: rocket/),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByLabelText('Name for Legacy'),
      '  Legacy renamed  ',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save type' }),
    );

    await waitFor(() =>
      expect(mockPatchCustomType).toHaveBeenCalledWith(
        TRIP_ID,
        UNKNOWN_TYPE_ID,
        { name: 'Legacy renamed' },
      ),
    );
    expect(await screen.findByText('Custom type updated.')).toBeTruthy();
    expect(
      screen.queryByLabelText('Name for Legacy'),
    ).toBeNull();
  });

  it('patches unknown color and icon only after explicit supported replacements', async () => {
    await render(<CustomTypeManagerScreen />);
    await focusScreen();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Edit Legacy' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Legacy color Violet' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Legacy icon Transport' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save type' }),
    );

    await waitFor(() =>
      expect(mockPatchCustomType).toHaveBeenCalledWith(
        TRIP_ID,
        UNKNOWN_TYPE_ID,
        {
          color_token: 'violet',
          icon_key: 'bus',
        },
      ),
    );
  });

  it.each([
    ['Deactivate Coffee', ACTIVE_TYPE_ID, false, 'Custom type deactivated.'],
    ['Activate Relax', INACTIVE_TYPE_ID, true, 'Custom type activated.'],
  ])(
    'handles %s with a minimal active-state PATCH',
    async (actionLabel, typeId, isActive, message) => {
      await render(<CustomTypeManagerScreen />);
      await focusScreen();
      mockRefresh.mockClear();

      await fireEvent.press(
        screen.getByRole('button', { name: actionLabel }),
      );

      await waitFor(() =>
        expect(mockPatchCustomType).toHaveBeenCalledWith(
          TRIP_ID,
          typeId,
          { is_active: isActive },
        ),
      );
      expect(await screen.findByText(message)).toBeTruthy();
      expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledWith('silent');
    },
  );

  it('confirms and deletes exactly once before publishing and reconciling', async () => {
    await render(<CustomTypeManagerScreen />);
    await focusScreen();
    mockRefresh.mockClear();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Coffee' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Coffee' }),
    );
    expect(mockAlert).toHaveBeenCalledTimes(1);
    await act(async () => {
      destructiveAlertAction()();
    });

    await waitFor(() =>
      expect(mockDeleteCustomType).toHaveBeenCalledWith(
        TRIP_ID,
        ACTIVE_TYPE_ID,
      ),
    );
    expect(await screen.findByText('Custom type deleted.')).toBeTruthy();
    expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith('silent');
  });

  it('shows duplicate and in-use 409 details verbatim and reconciles', async () => {
    mockCreateCustomType.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail:
          'A custom type with this name already exists for this trip.',
        error_code: 'CUSTOM_TYPE_DUPLICATE',
      }),
    );
    mockDeleteCustomType.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'Custom type is still used by timeline activities.',
        error_code: 'CUSTOM_TYPE_IN_USE',
      }),
    );
    await render(<CustomTypeManagerScreen />);
    await focusScreen();
    mockRefresh.mockClear();

    await fireEvent.changeText(
      screen.getByLabelText('New custom type name'),
      'Coffee',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add custom type' }),
    );
    expect(
      await screen.findByText(
        'A custom type with this name already exists for this trip.',
      ),
    ).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Coffee' }),
    );
    await act(async () => {
      destructiveAlertAction()();
    });
    expect(
      await screen.findByText(
        'Custom type is still used by timeline activities.',
      ),
    ).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenNthCalledWith(1, 'silent');
    expect(mockRefresh).toHaveBeenNthCalledWith(2, 'silent');
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409])(
    'silently reconciles an authoritative %s toggle failure',
    async (status) => {
      const detail = `Authority changed (${status}).`;
      mockPatchCustomType.mockRejectedValueOnce(
        axiosErrorWith(status, { detail }),
      );
      await render(<CustomTypeManagerScreen />);
      await focusScreen();
      mockRefresh.mockClear();

      await fireEvent.press(
        screen.getByRole('button', { name: 'Deactivate Coffee' }),
      );

      expect(await screen.findByText(detail)).toBeTruthy();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledWith('silent');
      expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
    },
  );

  it('renders normalized backend field errors verbatim', async () => {
    mockCreateCustomType.mockRejectedValueOnce(
      axiosErrorWith(400, {
        name: ['Use a different custom type name.'],
      }),
    );
    await render(<CustomTypeManagerScreen />);
    await focusScreen();
    await fireEvent.changeText(
      screen.getByLabelText('New custom type name'),
      'Server check',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add custom type' }),
    );

    expect(
      await screen.findByText('Use a different custom type name.'),
    ).toBeTruthy();
  });

  it('ignores late inactive failure state, navigation, event, and reconcile effects', async () => {
    const pending = deferred<TimelineCustomTypeMeta>();
    mockCreateCustomType.mockReturnValue(pending.promise);
    await render(<CustomTypeManagerScreen />);
    const blur = await focusScreen();
    mockRefresh.mockClear();
    await fireEvent.changeText(
      screen.getByLabelText('New custom type name'),
      'Late failure',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add custom type' }),
    );

    await act(async () => {
      blur?.();
      pending.reject(
        axiosErrorWith(409, {
          detail: 'This late failure must remain invisible.',
        }),
      );
    });

    expect(
      screen.queryByText('This late failure must remain invisible.'),
    ).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('publishes one late confirmed success without inactive UI, reconcile, or navigation', async () => {
    const pending = deferred<TimelineCustomTypeMeta>();
    mockCreateCustomType.mockReturnValue(pending.promise);
    await render(<CustomTypeManagerScreen />);
    const blur = await focusScreen();
    mockRefresh.mockClear();
    await fireEvent.changeText(
      screen.getByLabelText('New custom type name'),
      'Late success',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add custom type' }),
    );

    await act(async () => {
      blur?.();
      pending.resolve({
        ...activeType,
        id: '3549643d-88a9-486c-b855-92363429112f',
      });
    });

    await waitFor(() =>
      expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText('Custom type created.')).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});
