let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = { push: jest.fn() };
const mockUseTimeline = jest.fn();
const mockDeleteSection = jest.fn();
const mockDeleteActivity = jest.fn();
const mockUpdateActivityStatus = jest.fn();
const mockPublishTimelineEvent = jest.fn();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../hooks/useTimeline', () => ({
  useTimeline: (...args: unknown[]) => mockUseTimeline(...args),
}));
jest.mock('../api', () => ({
  deleteSection: (...args: unknown[]) => mockDeleteSection(...args),
  deleteActivity: (...args: unknown[]) => mockDeleteActivity(...args),
  updateActivityStatus: (...args: unknown[]) =>
    mockUpdateActivityStatus(...args),
}));
jest.mock('../timelineEvents', () => ({
  publishTimelineEvent: (...args: unknown[]) =>
    mockPublishTimelineEvent(...args),
}));

// eslint-disable-next-line import/first
import { Alert, SectionList } from 'react-native';
// eslint-disable-next-line import/first
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { AxiosError } from 'axios';
// eslint-disable-next-line import/first
import { TimelineScreen } from '../screens/TimelineScreen';
// eslint-disable-next-line import/first
import type {
  TimelineActivity,
  TimelineResponse,
  TimelineSection,
} from '../types';
// eslint-disable-next-line import/first
import type { ApiError } from '@/shared/api/errors';

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const SECOND_TRIP_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';

function buildActivity(
  overrides: Partial<TimelineActivity> = {},
): TimelineActivity {
  return {
    id: 'activity-1',
    title: 'Breakfast',
    time_mode: 'AT_TIME',
    start_time: '08:00:00',
    end_time: null,
    status: 'UPCOMING',
    position: 0,
    activity_type: {
      kind: 'SYSTEM',
      code: 'FOOD',
      label: 'Food',
      color_token: 'amber',
      icon_key: 'utensils',
    },
    assignee_scope: 'EVERYONE',
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
      can_edit: false,
      can_delete: false,
      can_update_status: false,
    },
    ...overrides,
  };
}

function buildSection(
  overrides: Partial<TimelineSection> = {},
): TimelineSection {
  return {
    id: 'section-1',
    section_date: '2000-01-01',
    label: 'Day 1',
    is_label_custom: false,
    is_in_trip_range: true,
    position: 0,
    activities: [],
    ...overrides,
  };
}

function buildTimeline(
  overrides: Partial<TimelineResponse> = {},
): TimelineResponse {
  return {
    trip_timezone: 'UTC',
    permissions: {
      can_edit_timeline: false,
      can_manage_custom_types: false,
      can_create_sections: false,
    },
    system_types: [],
    custom_types: [],
    sections: [],
    ...overrides,
  };
}

function hookState({
  timeline = buildTimeline(),
  status = 'ready',
  error = null,
  refreshing = false,
}: {
  timeline?: TimelineResponse | null;
  status?: 'loading' | 'ready' | 'error';
  error?: ApiError | null;
  refreshing?: boolean;
} = {}) {
  return {
    timeline,
    status,
    error,
    refreshing,
    refresh: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn(),
  };
}

describe('TimelineScreen', () => {
  let scrollSpy: jest.SpyInstance;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { tripId: TRIP_ID };
    mockUseTimeline.mockReturnValue(hookState());
    mockDeleteSection.mockResolvedValue(undefined);
    mockDeleteActivity.mockResolvedValue(undefined);
    mockUpdateActivityStatus.mockResolvedValue(undefined);
    mockPublishTimelineEvent.mockResolvedValue(undefined);
    scrollSpy = jest
      .spyOn(SectionList.prototype, 'scrollToLocation')
      .mockImplementation(() => undefined);
    alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    scrollSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('renders the first-load spinner without mounting ready content', async () => {
    mockUseTimeline.mockReturnValue(
      hookState({ timeline: null, status: 'loading' }),
    );
    const rendered = await render(<TimelineScreen />);

    expect(screen.queryByTestId('timeline-route-ready')).toBeNull();
    expect(
      rendered.container.queryAll((instance) =>
        instance.type.includes('ActivityIndicator'),
      ),
    ).toHaveLength(1);
  });

  it('shows a full error and retries it as an initial load', async () => {
    const state = hookState({
      timeline: null,
      status: 'error',
      error: {
        kind: 'message',
        message: 'Timeline service is unavailable.',
        status: 500,
      },
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    expect(screen.getByText('Could not load timeline')).toBeTruthy();
    expect(screen.getByText('Timeline service is unavailable.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refresh).toHaveBeenCalledWith('initial');
  });

  it('renders the neutral 404 state after the hook clears complete data', async () => {
    mockUseTimeline.mockReturnValue(
      hookState({
        timeline: null,
        status: 'error',
        error: {
          kind: 'message',
          message: 'Trip not found.',
          errorCode: 'TRIP_NOT_FOUND',
          status: 404,
        },
      }),
    );
    await render(<TimelineScreen />);

    expect(screen.getByText('Timeline not found')).toBeTruthy();
    expect(
      screen.getByText(
        'This trip does not exist or you no longer have access to it.',
      ),
    ).toBeTruthy();
  });

  it('shows the empty captain CTA and does not add an Expenses route', async () => {
    const state = hookState({
      timeline: buildTimeline({
        permissions: {
          can_edit_timeline: true,
          can_manage_custom_types: true,
          can_create_sections: true,
        },
      }),
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    expect(screen.getByText('No days yet')).toBeTruthy();
    expect(screen.queryByText('Expenses')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Add day' }));
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/trips/${TRIP_ID}/timeline/section-form?mode=create`,
    );
  });

  it('hides the empty CTA when aggregate permission denies section creation', async () => {
    await render(<TimelineScreen />);

    expect(screen.getByText('No days yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add day' })).toBeNull();
  });

  it('wires section controls and the non-empty add-day action from aggregate permissions', async () => {
    mockUseTimeline.mockReturnValue(
      hookState({
        timeline: buildTimeline({
          permissions: {
            can_edit_timeline: true,
            can_manage_custom_types: false,
            can_create_sections: true,
          },
          sections: [buildSection({ label: 'Arrival' })],
        }),
      }),
    );
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Edit Arrival' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/trips/${TRIP_ID}/timeline/section-form?mode=edit&sectionId=section-1`,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Add day' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      `/trips/${TRIP_ID}/timeline/section-form?mode=create`,
    );
  });

  it('cancels section deletion without calling the API', async () => {
    mockUseTimeline.mockReturnValue(
      hookState({
        timeline: buildTimeline({
          permissions: {
            can_edit_timeline: true,
            can_manage_custom_types: false,
            can_create_sections: false,
          },
          sections: [buildSection({ label: 'Arrival' })],
        }),
      }),
    );
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Arrival' }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'Delete timeline day?',
      'Delete Arrival and all activities in it? This cannot be undone.',
      expect.any(Array),
      expect.objectContaining({ cancelable: true }),
    );
    const buttons = alertSpy.mock.calls[0]?.[2] as
      | { text?: string; onPress?: () => void }[]
      | undefined;
    await act(async () => {
      buttons?.find((button) => button.text === 'Cancel')?.onPress?.();
    });

    expect(mockDeleteSection).not.toHaveBeenCalled();
  });

  it('invalidates, deletes, publishes, and keeps a ref lock across duplicate confirmation', async () => {
    let resolveDelete: (() => void) | undefined;
    mockDeleteSection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const state = hookState({
      timeline: buildTimeline({
        permissions: {
          can_edit_timeline: true,
          can_manage_custom_types: false,
          can_create_sections: false,
        },
        sections: [buildSection({ label: 'Arrival' })],
      }),
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Arrival' }),
    );
    const buttons = alertSpy.mock.calls[0]?.[2] as
      | { text?: string; onPress?: () => void }[]
      | undefined;
    const confirm = buttons?.find((button) => button.text === 'Delete');
    await act(async () => {
      confirm?.onPress?.();
      confirm?.onPress?.();
    });

    expect(state.invalidate).toHaveBeenCalledTimes(1);
    expect(mockDeleteSection).toHaveBeenCalledTimes(1);
    expect(mockDeleteSection).toHaveBeenCalledWith(TRIP_ID, 'section-1');

    await act(async () => {
      resolveDelete?.();
    });
    await waitFor(() =>
      expect(mockPublishTimelineEvent).toHaveBeenCalledWith({
        type: 'timelineChanged',
        tripId: TRIP_ID,
      }),
    );
  });

  it('shows a verbatim conflict and silently reconciles after delete failure', async () => {
    const conflict = new AxiosError(
      'Conflict',
      undefined,
      undefined,
      undefined,
      {
        status: 409,
        statusText: 'Conflict',
        headers: {},
        config: {} as never,
        data: { detail: 'This timeline day changed on another device.' },
      },
    );
    mockDeleteSection.mockRejectedValue(conflict);
    const state = hookState({
      timeline: buildTimeline({
        permissions: {
          can_edit_timeline: true,
          can_manage_custom_types: false,
          can_create_sections: false,
        },
        sections: [buildSection({ label: 'Arrival' })],
      }),
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Arrival' }),
    );
    const buttons = alertSpy.mock.calls[0]?.[2] as
      | { text?: string; onPress?: () => void }[]
      | undefined;
    await act(async () => {
      buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });

    await waitFor(() =>
      expect(
        screen.getByText('This timeline day changed on another device.'),
      ).toBeTruthy(),
    );
    expect(state.refresh).toHaveBeenCalledWith('silent');
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
  });

  it('opens create and edit activity forms from the authoritative section data', async () => {
    mockUseTimeline.mockReturnValue(
      hookState({
        timeline: buildTimeline({
          permissions: {
            can_edit_timeline: true,
            can_manage_custom_types: false,
            can_create_sections: false,
          },
          sections: [
            buildSection({
              label: 'Arrival',
              activities: [
                buildActivity({
                  title: 'Airport transfer',
                  capabilities: {
                    can_edit: true,
                    can_delete: false,
                    can_update_status: false,
                  },
                }),
              ],
            }),
          ],
        }),
      }),
    );
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Add activity to Arrival' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/trips/${TRIP_ID}/timeline/activity-form?mode=create&sectionId=section-1`,
    );

    await fireEvent.press(
      screen.getByRole('button', { name: 'Edit Airport transfer' }),
    );
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      `/trips/${TRIP_ID}/timeline/activity-form?mode=edit&activityId=activity-1`,
    );
  });

  it('deletes an activity only after confirmation and publishes one authoritative refresh event', async () => {
    const state = hookState({
      timeline: buildTimeline({
        permissions: {
          can_edit_timeline: true,
          can_manage_custom_types: false,
          can_create_sections: false,
        },
        sections: [
          buildSection({
            label: 'Arrival',
            activities: [
              buildActivity({
                title: 'Airport transfer',
                capabilities: {
                  can_edit: false,
                  can_delete: true,
                  can_update_status: false,
                },
              }),
            ],
          }),
        ],
      }),
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Airport transfer' }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'Delete activity?',
      'Delete Airport transfer? This cannot be undone.',
      expect.any(Array),
      expect.objectContaining({ cancelable: true }),
    );
    const buttons = alertSpy.mock.calls[0]?.[2] as
      | { text?: string; onPress?: () => void }[]
      | undefined;
    await act(async () => {
      buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });

    await waitFor(() =>
      expect(mockDeleteActivity).toHaveBeenCalledWith(
        TRIP_ID,
        'activity-1',
      ),
    );
    expect(state.invalidate).toHaveBeenCalledTimes(1);
    expect(mockPublishTimelineEvent).toHaveBeenCalledWith({
      type: 'timelineChanged',
      tripId: TRIP_ID,
    });
  });

  it('updates status through the row capability and reconciles a rejected transition', async () => {
    const conflict = new AxiosError(
      'Conflict',
      undefined,
      undefined,
      undefined,
      {
        status: 409,
        statusText: 'Conflict',
        headers: {},
        config: {} as never,
        data: {
          detail: 'This status transition is no longer allowed.',
          error_code: 'INVALID_STATUS_TRANSITION',
        },
      },
    );
    mockUpdateActivityStatus.mockRejectedValue(conflict);
    const state = hookState({
      timeline: buildTimeline({
        sections: [
          buildSection({
            activities: [
              buildActivity({
                title: 'Airport transfer',
                capabilities: {
                  can_edit: false,
                  can_delete: false,
                  can_update_status: true,
                },
              }),
            ],
          }),
        ],
      }),
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Expand Airport transfer details',
      }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Start activity' }),
    );

    expect(
      await screen.findByText(
        'This status transition is no longer allowed.',
      ),
    ).toBeTruthy();
    expect(mockUpdateActivityStatus).toHaveBeenCalledWith(
      TRIP_ID,
      'activity-1',
      { status: 'IN_PROGRESS' },
    );
    expect(state.invalidate).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledWith('silent');
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
  });

  it('keeps rows visible with an inline error and retries silently', async () => {
    const state = hookState({
      timeline: buildTimeline({
        sections: [
          buildSection({
            activities: [
              buildActivity({
                id: 'all-day',
                title: 'Hotel check-in',
                time_mode: 'ALL_DAY',
                start_time: null,
              }),
              buildActivity(),
              buildActivity({
                id: 'flexible',
                title: 'Explore old town',
                time_mode: 'FLEXIBLE',
                start_time: null,
              }),
            ],
          }),
        ],
      }),
      error: {
        kind: 'message',
        message: 'Could not refresh the timeline.',
        status: 500,
      },
    });
    mockUseTimeline.mockReturnValue(state);
    await render(<TimelineScreen />);

    expect(screen.getByText('Hotel check-in')).toBeTruthy();
    expect(screen.getByText('Breakfast')).toBeTruthy();
    expect(screen.getByText('Explore old town')).toBeTruthy();
    expect(screen.getAllByText('All day')).toHaveLength(2);
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getAllByText('Flexible')).toHaveLength(2);
    expect(screen.getByText('Could not refresh the timeline.')).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Retry refreshing timeline' }),
    );
    expect(state.refresh).toHaveBeenCalledWith('silent');
  });

  it('uses the explicit refresh mode for pull-to-refresh', async () => {
    const state = hookState();
    mockUseTimeline.mockReturnValue(state);
    const rendered = await render(<TimelineScreen />);

    const refreshControl = rendered.container.queryAll(
      (instance) => instance.type === 'RCTRefreshControl',
    )[0];
    if (!refreshControl) {
      throw new Error('Expected Timeline RefreshControl.');
    }
    await fireEvent(refreshControl, 'refresh');
    expect(state.refresh).toHaveBeenCalledWith('refresh');
  });

  it('scrolls to the default day only once per trip resource mount', async () => {
    const firstTimeline = buildTimeline({
      sections: [
        buildSection({ id: 'day-1', section_date: '2000-01-01' }),
        buildSection({ id: 'day-2', section_date: '2000-01-02' }),
      ],
    });
    mockUseTimeline.mockReturnValue(hookState({ timeline: firstTimeline }));
    const rendered = await render(<TimelineScreen />);

    await waitFor(() =>
      expect(scrollSpy).toHaveBeenCalledWith({
        animated: false,
        sectionIndex: 1,
        itemIndex: 0,
        viewPosition: 0,
      }),
    );

    mockUseTimeline.mockReturnValue(
      hookState({
        timeline: buildTimeline({
          sections: [
            ...firstTimeline.sections,
            buildSection({ id: 'day-3', section_date: '2000-01-03' }),
          ],
        }),
      }),
    );
    await rendered.rerender(<TimelineScreen />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    mockParams = { tripId: SECOND_TRIP_ID };
    mockUseTimeline.mockReturnValue(
      hookState({
        timeline: buildTimeline({
          sections: [
            buildSection({ id: 'other-day', section_date: '2001-01-01' }),
          ],
        }),
      }),
    );
    await rendered.rerender(<TimelineScreen />);
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
  });
});
