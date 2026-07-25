import type { ComponentProps, ReactNode } from 'react';
import { View } from 'react-native';
import type { ActivityForm } from '../components/ActivityForm';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = {
  dismissTo: jest.fn(),
  push: jest.fn(),
};
const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();
const mockUseTimeline = jest.fn();
const mockUseTripDetail = jest.fn();
const mockRefreshTimeline = jest.fn();
const mockRefreshTrip = jest.fn();
const mockInvalidateTimeline = jest.fn();
const mockPublishTimelineEvent = jest.fn();
const mockSubscribeToTimelineEvents = jest.fn();
const mockSubscribeToTripEvents = jest.fn();
let mockActivityFormProps: unknown;
let mockTimelineListener:
  | ((event: { type: 'timelineChanged'; tripId: string }) =>
      void | Promise<void>)
  | undefined;
let mockTripListener:
  | ((event: {
      type: 'statusChanged';
      tripId: string;
      status: 'PLANNING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
    }) => void)
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

function mockRenderActivityForm(props: unknown) {
  mockActivityFormProps = props;
  return <View testID="mock-activity-form" />;
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
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args),
}));
jest.mock('../components/ActivityForm', () => ({
  ActivityForm: mockRenderActivityForm,
}));
jest.mock('../api', () => ({
  createActivity: jest.fn(),
  patchActivity: jest.fn(),
}));
jest.mock('../timelineEvents', () => ({
  publishTimelineEvent: (...args: unknown[]) =>
    mockPublishTimelineEvent(...args),
  subscribeToTimelineEvents: (...args: unknown[]) =>
    mockSubscribeToTimelineEvents(...args),
}));
jest.mock('@/features/trips/tripEvents', () => ({
  subscribeToTripEvents: (...args: unknown[]) =>
    mockSubscribeToTripEvents(...args),
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
import { createActivity, patchActivity } from '../api';
// eslint-disable-next-line import/first
import { ActivityFormScreen } from '../screens/ActivityFormScreen';
// eslint-disable-next-line import/first
import type { TripDetailResponse } from '@/features/trips/types';
// eslint-disable-next-line import/first
import type {
  TimelineActivity,
  TimelineResponse,
  TimelineSection,
} from '../types';

const mockCreateActivity = createActivity as jest.MockedFunction<
  typeof createActivity
>;
const mockPatchActivity = patchActivity as jest.MockedFunction<
  typeof patchActivity
>;

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const SECTION_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const ACTIVITY_ID = 'a11957b3-3329-4fcf-9c7b-673a51c1d8a7';
const OTHER_ACTIVITY_ID = '7191f7c4-16f0-4fc5-996f-3264a46e7761';

function activity(
  overrides: Partial<TimelineActivity> = {},
): TimelineActivity {
  return {
    id: ACTIVITY_ID,
    title: 'Breakfast',
    time_mode: 'AT_TIME',
    start_time: '08:00:00',
    end_time: null,
    status: 'UPCOMING',
    position: 0,
    activity_type: {
      kind: 'SYSTEM',
      code: 'OTHER',
      label: 'Other',
      color_token: 'slate',
      icon_key: 'tag',
    },
    assignee_scope: 'NONE',
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
      can_edit: true,
      can_delete: true,
      can_update_status: true,
    },
    ...overrides,
  };
}

function section(
  activities: TimelineActivity[] = [activity()],
): TimelineSection {
  return {
    id: SECTION_ID,
    section_date: '2026-08-01',
    label: 'Arrival',
    is_label_custom: true,
    is_in_trip_range: true,
    position: 0,
    activities,
  };
}

function timeline(
  overrides: Partial<TimelineResponse> = {},
): TimelineResponse {
  return {
    trip_timezone: 'Asia/Ho_Chi_Minh',
    permissions: {
      can_edit_timeline: true,
      can_manage_custom_types: true,
      can_create_sections: true,
    },
    system_types: [
      {
        code: 'OTHER',
        label: 'Other',
        color_token: 'slate',
        icon_key: 'tag',
      },
    ],
    custom_types: [],
    sections: [section()],
    ...overrides,
  };
}

function tripDetail(
  overrides: {
    tripStatus?: TripDetailResponse['trip']['status'];
    membershipStatus?: TripDetailResponse['my_membership']['status'];
  } = {},
): TripDetailResponse {
  return {
    trip: {
      id: TRIP_ID,
      name: 'Da Nang weekend',
      destination: 'Da Nang, Vietnam',
      destination_provider: '',
      destination_provider_id: '',
      destination_lat: null,
      destination_lng: null,
      destination_country_code: 'VN',
      cover_image_url: '',
      start_date: '2026-08-01',
      end_date: '2026-08-03',
      description: '',
      status: overrides.tripStatus ?? 'PLANNING',
      currency_code: 'VND',
      timezone: 'Asia/Ho_Chi_Minh',
      budget_estimate: null,
      cancelled_at: null,
      created_at: '2026-01-01T00:00:00Z',
    },
    my_membership: {
      role: 'CAPTAIN',
      status: overrides.membershipStatus ?? 'ACTIVE',
      joined_at: '2026-01-01T00:00:00Z',
    },
    members: [
      {
        membership_id: 'membership-1',
        user: {
          id: 'member-1',
          display_name: 'Minh',
          identify_tag: 'minh',
          avatar_url: null,
        },
        role: 'CAPTAIN',
        joined_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
}

function readyTimelineHook(nextTimeline = timeline()) {
  return {
    timeline: nextTimeline,
    status: 'ready' as const,
    error: null,
    refreshing: false,
    refresh: mockRefreshTimeline,
    invalidate: mockInvalidateTimeline,
  };
}

function loadingTimelineHook() {
  return {
    timeline: null,
    status: 'loading' as const,
    error: null,
    refreshing: false,
    refresh: mockRefreshTimeline,
    invalidate: mockInvalidateTimeline,
  };
}

function readyTripHook(nextDetail = tripDetail()) {
  return {
    detail: nextDetail,
    status: 'ready' as const,
    error: null,
    refreshing: false,
    refresh: mockRefreshTrip,
  };
}

function loadingTripHook() {
  return {
    detail: null,
    status: 'loading' as const,
    error: null,
    refreshing: false,
    refresh: mockRefreshTrip,
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

function currentFormProps(): ComponentProps<typeof ActivityForm> {
  if (!mockActivityFormProps) {
    throw new Error('Expected ActivityForm to be rendered.');
  }
  return mockActivityFormProps as ComponentProps<typeof ActivityForm>;
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

async function changeDraft(
  mutate: (
    draft: ComponentProps<typeof ActivityForm>['draft'],
  ) => ComponentProps<typeof ActivityForm>['draft'],
  fields: Parameters<
    ComponentProps<typeof ActivityForm>['onDraftChange']
  >[1],
): Promise<void> {
  const props = currentFormProps();
  await act(async () => {
    props.onDraftChange(mutate(props.draft), fields);
  });
}

describe('ActivityFormScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      activityId: ACTIVITY_ID,
    };
    mockActivityFormProps = undefined;
    mockTimelineListener = undefined;
    mockTripListener = undefined;
    mockLatestStackOptions = undefined;
    mockRefreshTimeline.mockResolvedValue(undefined);
    mockRefreshTrip.mockResolvedValue(undefined);
    mockUseTimeline.mockReturnValue(readyTimelineHook());
    mockUseTripDetail.mockReturnValue(readyTripHook());
    mockCreateActivity.mockResolvedValue(activity());
    mockPatchActivity.mockResolvedValue(activity());
    mockSubscribeToTimelineEvents.mockImplementation(
      (
        _tripId: string,
        listener: (
          event: { type: 'timelineChanged'; tripId: string },
        ) => void | Promise<void>,
      ) => {
        mockTimelineListener = listener;
        return () => {
          if (mockTimelineListener === listener) {
            mockTimelineListener = undefined;
          }
        };
      },
    );
    mockPublishTimelineEvent.mockImplementation(
      async (event: { type: 'timelineChanged'; tripId: string }) => {
        await mockTimelineListener?.(event);
      },
    );
    mockSubscribeToTripEvents.mockImplementation(
      (
        listener: (event: {
          type: 'statusChanged';
          tripId: string;
          status: 'PLANNING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
        }) => void,
      ) => {
        mockTripListener = listener;
        return () => {
          if (mockTripListener === listener) {
            mockTripListener = undefined;
          }
        };
      },
    );
  });

  it('rejects invalid route intent before mounting either data hook', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: SECTION_ID,
      activityId: ACTIVITY_ID,
    };

    await render(<ActivityFormScreen />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(mockUseTimeline).not.toHaveBeenCalled();
    expect(mockUseTripDetail).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
    expect(mockPatchActivity).not.toHaveBeenCalled();
  });

  it.each(['timeline-first', 'trip-first'] as const)(
    'waits for both authoritative sources before hydrating (%s)',
    async (order) => {
      if (order === 'timeline-first') {
        mockUseTimeline.mockReturnValue(readyTimelineHook());
        mockUseTripDetail.mockReturnValue(loadingTripHook());
      } else {
        mockUseTimeline.mockReturnValue(loadingTimelineHook());
        mockUseTripDetail.mockReturnValue(readyTripHook());
      }
      const view = await render(<ActivityFormScreen />);

      expect(screen.queryByTestId('mock-activity-form')).toBeNull();
      expect(mockActivityFormProps).toBeUndefined();

      mockUseTimeline.mockReturnValue(readyTimelineHook());
      mockUseTripDetail.mockReturnValue(readyTripHook());
      await view.rerender(<ActivityFormScreen />);

      expect(screen.getByTestId('mock-activity-form')).toBeTruthy();
      expect(currentFormProps().draft.title).toBe('Breakfast');
      expect(mockUseTimeline).toHaveBeenCalledWith(TRIP_ID, {
        autoReconcile: false,
      });
      expect(mockUseTripDetail).toHaveBeenCalledWith(TRIP_ID, {
        autoReconcile: false,
      });
    },
  );

  it('hydrates once, preserves edits across authority refresh, and rehydrates for a new route identity', async () => {
    const view = await render(<ActivityFormScreen />);
    await changeDraft(
      (draft) => ({ ...draft, title: 'My immutable draft' }),
      ['title'],
    );

    mockUseTimeline.mockReturnValue(
      readyTimelineHook(
        timeline({
          sections: [
            section([
              activity({ title: 'Server refresh title' }),
              activity({
                id: OTHER_ACTIVITY_ID,
                title: 'Dinner',
                position: 1,
              }),
            ]),
          ],
        }),
      ),
    );
    mockUseTripDetail.mockReturnValue(
      readyTripHook(tripDetail({ membershipStatus: 'REMOVED' })),
    );
    await view.rerender(<ActivityFormScreen />);

    expect(currentFormProps().draft.title).toBe('My immutable draft');
    expect(currentFormProps().canSubmit).toBe(false);
    expect(currentFormProps().authorityMessage).toBe(
      'You are no longer an active member of this trip.',
    );

    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      activityId: OTHER_ACTIVITY_ID,
    };
    mockUseTripDetail.mockReturnValue(readyTripHook());
    await view.rerender(<ActivityFormScreen />);

    expect(currentFormProps().draft.title).toBe('Dinner');
    expect(currentFormProps().canSubmit).toBe(true);
  });

  it('creates with a full payload, locks duplicate submit and Cancel, then reconciles once before dismissing', async () => {
    const pending = deferred<TimelineActivity>();
    mockCreateActivity.mockReturnValue(pending.promise);
    mockParams = {
      tripId: TRIP_ID,
      mode: 'create',
      sectionId: SECTION_ID,
    };
    await render(<ActivityFormScreen />);
    await focusScreen();
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();

    await changeDraft(
      (draft) => ({
        ...draft,
        title: '  Coffee stop  ',
        start_time: '09:15',
      }),
      ['title', 'start_time'],
    );
    const props = currentFormProps();
    await act(async () => {
      props.onSubmit();
      props.onSubmit();
    });

    await waitFor(() =>
      expect(mockCreateActivity).toHaveBeenCalledTimes(1),
    );
    expect(mockCreateActivity).toHaveBeenCalledWith(
      TRIP_ID,
      SECTION_ID,
      {
        title: 'Coffee stop',
        time_mode: 'AT_TIME',
        start_time: '09:15',
        end_time: null,
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
      },
    );
    expect(mockInvalidateTimeline).toHaveBeenCalledTimes(1);
    expect(mockLatestStackOptions?.gestureEnabled).toBe(false);
    expect(currentFormProps().submitting).toBe(true);
    expect(
      screen.getByLabelText('Cancel timeline activity form').props
        .accessibilityState,
    ).toMatchObject({ disabled: true });
    await fireEvent.press(
      screen.getByLabelText('Cancel timeline activity form'),
    );
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(activity({ title: 'Coffee stop' }));
    });

    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/timeline`,
      ),
    );
    expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1);
    expect(mockRefreshTimeline).toHaveBeenCalledTimes(1);
    expect(mockRefreshTrip).toHaveBeenCalledTimes(1);
    expect(mockRefreshTimeline).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    expect(mockInvalidateTimeline.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateActivity.mock.invocationCallOrder[0]!,
    );
    expect(mockCreateActivity.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishTimelineEvent.mock.invocationCallOrder[0]!,
    );
    expect(mockRefreshTimeline.mock.invocationCallOrder[0]).toBeLessThan(
      mockRouter.dismissTo.mock.invocationCallOrder[0]!,
    );
  });

  it('sends only dirty changed fields in edit PATCH', async () => {
    await render(<ActivityFormScreen />);
    await focusScreen();
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();
    await changeDraft(
      (draft) => ({ ...draft, title: '  Updated breakfast  ' }),
      ['title'],
    );

    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(mockPatchActivity).toHaveBeenCalledWith(
        TRIP_ID,
        ACTIVITY_ID,
        { title: 'Updated breakfast' },
      ),
    );
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  it('refreshes both sources after an active 409 without publishing or navigating', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'create',
      sectionId: SECTION_ID,
    };
    mockCreateActivity.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'The timeline changed before this save.',
      }),
    );
    await render(<ActivityFormScreen />);
    await focusScreen();
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();
    await changeDraft(
      (draft) => ({
        ...draft,
        title: 'Conflict',
        start_time: '10:00',
      }),
      ['title', 'start_time'],
    );

    await act(async () => {
      currentFormProps().onSubmit();
    });

    await waitFor(() =>
      expect(currentFormProps().submitError?.message).toBe(
        'The timeline changed before this save.',
      ),
    );
    expect(mockRefreshTimeline).toHaveBeenCalledTimes(1);
    expect(mockRefreshTrip).toHaveBeenCalledTimes(1);
    expect(mockRefreshTimeline).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('ignores a late failure after unmount without event, refresh, or navigation effects', async () => {
    const pending = deferred<TimelineActivity>();
    mockCreateActivity.mockReturnValue(pending.promise);
    mockParams = {
      tripId: TRIP_ID,
      mode: 'create',
      sectionId: SECTION_ID,
    };
    const view = await render(<ActivityFormScreen />);
    const blur = await focusScreen();
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();
    await changeDraft(
      (draft) => ({
        ...draft,
        title: 'Late failure',
        start_time: '11:00',
      }),
      ['title', 'start_time'],
    );
    await act(async () => {
      currentFormProps().onSubmit();
    });
    await waitFor(() =>
      expect(mockCreateActivity).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      blur?.();
    });
    await view.unmount();
    await act(async () => {
      pending.reject(
        axiosErrorWith(409, {
          detail: 'This unmounted error must remain invisible.',
        }),
      );
    });

    expect(mockRefreshTimeline).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('publishes one late success after unmount without refresh or navigation', async () => {
    const pending = deferred<TimelineActivity>();
    mockCreateActivity.mockReturnValue(pending.promise);
    mockParams = {
      tripId: TRIP_ID,
      mode: 'create',
      sectionId: SECTION_ID,
    };
    const view = await render(<ActivityFormScreen />);
    const blur = await focusScreen();
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();
    await changeDraft(
      (draft) => ({
        ...draft,
        title: 'Late success',
        start_time: '12:00',
      }),
      ['title', 'start_time'],
    );
    await act(async () => {
      currentFormProps().onSubmit();
    });
    await waitFor(() =>
      expect(mockCreateActivity).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      blur?.();
    });
    await view.unmount();
    await act(async () => {
      pending.resolve(activity({ title: 'Late success' }));
    });

    await waitFor(() =>
      expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1),
    );
    expect(mockRefreshTimeline).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('reconciles both sources for focus, foreground, timeline, and matching trip events only', async () => {
    await render(<ActivityFormScreen />);
    await focusScreen();

    expect(mockRefreshTimeline).toHaveBeenCalledWith('initial');
    expect(mockRefreshTrip).toHaveBeenCalledWith('initial');
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      await mockTimelineListener?.({
        type: 'timelineChanged',
        tripId: TRIP_ID,
      });
    });
    expect(mockRefreshTimeline).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();

    await act(async () => {
      mockTripListener?.({
        type: 'statusChanged',
        tripId: 'another-trip',
        status: 'COMPLETED',
      });
    });
    expect(mockRefreshTimeline).not.toHaveBeenCalled();
    expect(mockRefreshTrip).not.toHaveBeenCalled();

    await act(async () => {
      mockTripListener?.({
        type: 'statusChanged',
        tripId: TRIP_ID,
        status: 'COMPLETED',
      });
    });
    expect(mockRefreshTimeline).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
    mockRefreshTimeline.mockClear();
    mockRefreshTrip.mockClear();

    const foreground = mockUseAppForegroundEffect.mock.calls.at(-1)?.[0] as
      | (() => void)
      | undefined;
    if (!foreground) {
      throw new Error('Expected foreground callback registration.');
    }
    await act(async () => {
      foreground();
    });
    expect(mockRefreshTimeline).toHaveBeenCalledWith('silent');
    expect(mockRefreshTrip).toHaveBeenCalledWith('silent');
  });
});
