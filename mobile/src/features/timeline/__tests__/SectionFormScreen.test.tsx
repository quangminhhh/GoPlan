import { Pressable, Text, View } from 'react-native';

let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = { dismissTo: jest.fn() };
const mockUseFocusEffect = jest.fn();
const mockUseAppForegroundEffect = jest.fn();
const mockUseTimeline = jest.fn();
const mockRefresh = jest.fn();
const mockInvalidate = jest.fn();
const mockPublishTimelineEvent = jest.fn();
const mockSubscribeToTimelineEvents = jest.fn();
const mockGetTodayDateInTimeZone = jest.fn();
let mockTimelineListener:
  | ((event: { type: 'timelineChanged'; tripId: string }) =>
      void | Promise<void>)
  | undefined;
let mockLatestStackOptions:
  | {
      gestureEnabled?: boolean;
      headerLeft?: () => React.ReactNode;
    }
  | undefined;

function mockRenderStackScreen({
  options,
}: {
  options: {
    gestureEnabled?: boolean;
    headerLeft?: () => React.ReactNode;
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
  createSection: jest.fn(),
  patchSection: jest.fn(),
}));
jest.mock('../timelineEvents', () => ({
  publishTimelineEvent: (...args: unknown[]) =>
    mockPublishTimelineEvent(...args),
  subscribeToTimelineEvents: (...args: unknown[]) =>
    mockSubscribeToTimelineEvents(...args),
}));
jest.mock('../viewModel', () => ({
  getTodayDateInTimeZone: (...args: unknown[]) =>
    mockGetTodayDateInTimeZone(...args),
}));

interface MockDateFieldProps {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  error?: string;
}

function formatMockDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return 'invalid';
  }
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function MockDateField({
  label,
  value,
  onChange,
  error,
}: MockDateFieldProps) {
  return (
    <View>
      <Text>{label}</Text>
      <Text testID="section-date-value">{formatMockDate(value)}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose free date"
        onPress={() => onChange(new Date(2026, 7, 3, 12))}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose occupied date"
        onPress={() => onChange(new Date(2026, 7, 2, 12))}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose invalid date"
        onPress={() => onChange(new Date(Number.NaN))}
      />
      {error ? <Text>{error}</Text> : null}
    </View>
  );
}

jest.mock('@/shared/ui/DateField', () => ({
  DateField: MockDateField,
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
import { createSection, patchSection } from '../api';
// eslint-disable-next-line import/first
import { SectionFormScreen } from '../screens/SectionFormScreen';
// eslint-disable-next-line import/first
import type {
  TimelineResponse,
  TimelineSection,
} from '../types';

const mockCreateSection = createSection as jest.MockedFunction<
  typeof createSection
>;
const mockPatchSection = patchSection as jest.MockedFunction<
  typeof patchSection
>;

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const SECTION_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const OTHER_SECTION_ID = '78f52d4e-c187-44fa-85b8-ad4fb2dcb8bd';

const section: TimelineSection = {
  id: SECTION_ID,
  section_date: '2026-08-01',
  label: 'Arrival',
  is_label_custom: true,
  is_in_trip_range: true,
  position: 0,
  activities: [],
};

const otherSection: TimelineSection = {
  ...section,
  id: OTHER_SECTION_ID,
  section_date: '2026-08-02',
  label: 'Explore',
  position: 1,
};

function timeline(
  permissions: Partial<TimelineResponse['permissions']> = {},
): TimelineResponse {
  return {
    trip_timezone: 'Asia/Ho_Chi_Minh',
    permissions: {
      can_edit_timeline: true,
      can_manage_custom_types: true,
      can_create_sections: true,
      ...permissions,
    },
    system_types: [],
    custom_types: [],
    sections: [section, otherSection],
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

describe('SectionFormScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    mockTimelineListener = undefined;
    mockLatestStackOptions = undefined;
    mockRefresh.mockResolvedValue(undefined);
    mockGetTodayDateInTimeZone.mockReturnValue('2026-08-03');
    mockUseTimeline.mockReturnValue(readyHook());
    mockCreateSection.mockResolvedValue({
      ...section,
      id: 'd347da49-671a-48ec-bcae-aa5ef33ba28f',
      section_date: '2026-08-03',
    });
    mockPatchSection.mockResolvedValue(section);
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

  it('rejects malformed route intent before loading or mutating', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: [SECTION_ID],
    };

    await render(<SectionFormScreen />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(mockUseTimeline).not.toHaveBeenCalled();
    expect(mockCreateSection).not.toHaveBeenCalled();
    expect(mockPatchSection).not.toHaveBeenCalled();
  });

  it('gates create and edit direct links with aggregate capabilities', async () => {
    mockUseTimeline.mockReturnValue(
      readyHook(
        timeline({
          can_create_sections: false,
          can_edit_timeline: false,
        }),
      ),
    );
    const view = await render(<SectionFormScreen />);

    expect(
      screen.getByText(
        'You do not have permission to manage timeline days.',
      ),
    ).toBeTruthy();
    expect(mockUseTimeline).toHaveBeenCalledWith(TRIP_ID, {
      autoReconcile: false,
    });

    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: SECTION_ID,
    };
    await view.rerender(<SectionFormScreen />);

    expect(
      screen.getByText(
        'You do not have permission to manage timeline days.',
      ),
    ).toBeTruthy();
    expect(mockCreateSection).not.toHaveBeenCalled();
    expect(mockPatchSection).not.toHaveBeenCalled();
  });

  it('hydrates edit state once and preserves the immutable initial snapshot', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: SECTION_ID,
    };
    const view = await render(<SectionFormScreen />);

    expect(screen.getByLabelText('Day label').props.value).toBe('Arrival');
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'My draft',
    );

    mockUseTimeline.mockReturnValue(
      readyHook({
        ...timeline(),
        sections: [{ ...section, label: 'Server update' }, otherSection],
      }),
    );
    await view.rerender(<SectionFormScreen />);

    expect(screen.getByLabelText('Day label').props.value).toBe('My draft');
  });

  it('keeps the draft mounted and read-only while authority is lost, then restores editing', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: SECTION_ID,
    };
    const view = await render(<SectionFormScreen />);
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'Authority-safe draft',
    );

    mockUseTimeline.mockReturnValue(
      readyHook(
        timeline({
          can_create_sections: false,
          can_edit_timeline: false,
        }),
      ),
    );
    await view.rerender(<SectionFormScreen />);

    expect(
      screen.getByText(
        'You do not have permission to manage timeline days.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Day label').props.value).toBe(
      'Authority-safe draft',
    );
    expect(screen.getByLabelText('Day label').props.editable).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Save day' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: true });

    mockUseTimeline.mockReturnValue(
      readyHook({
        ...timeline(),
        sections: [{ ...section, label: 'Server update' }, otherSection],
      }),
    );
    await view.rerender(<SectionFormScreen />);

    expect(
      screen.queryByText(
        'You do not have permission to manage timeline days.',
      ),
    ).toBeNull();
    expect(screen.getByLabelText('Day label').props.value).toBe(
      'Authority-safe draft',
    );
    expect(screen.getByLabelText('Day label').props.editable).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Save day' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it('validates label and date, and blocks dates already used by another day', async () => {
    await render(<SectionFormScreen />);

    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );
    expect(screen.getByText('Label is required.')).toBeTruthy();

    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'x'.repeat(121),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );
    expect(
      screen.getByText('Label must be 120 characters or fewer.'),
    ).toBeTruthy();

    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'Valid label',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose invalid date' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );
    expect(screen.getByText('Enter a valid date.')).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Choose occupied date' }),
    );
    expect(
      screen.getByText('This date already has a timeline day.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Add day' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('creates with the trip-timezone date then reconciles once through the event before dismissing', async () => {
    await render(<SectionFormScreen />);
    await focusScreen();
    mockRefresh.mockClear();

    expect(mockGetTodayDateInTimeZone).toHaveBeenCalledWith(
      'Asia/Ho_Chi_Minh',
    );
    expect(screen.getByTestId('section-date-value').props.children).toBe(
      '2026-08-03',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      '  Extra day  ',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );

    await waitFor(() =>
      expect(mockCreateSection).toHaveBeenCalledWith(TRIP_ID, {
        section_date: '2026-08-03',
        label: 'Extra day',
      }),
    );
    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/timeline`,
      ),
    );
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith('silent');
    expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishTimelineEvent).toHaveBeenCalledWith({
      type: 'timelineChanged',
      tripId: TRIP_ID,
    });
    expect(mockInvalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSection.mock.invocationCallOrder[0]!,
    );
    expect(mockCreateSection.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishTimelineEvent.mock.invocationCallOrder[0]!,
    );
  });

  it('sends a minimal edit PATCH and locks submit, Cancel, and gestures until settled', async () => {
    const pending = deferred<TimelineSection>();
    mockPatchSection.mockReturnValue(pending.promise);
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: SECTION_ID,
    };
    await render(<SectionFormScreen />);
    await focusScreen();
    mockRefresh.mockClear();

    expect(
      screen.getByRole('button', { name: 'Save day' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: true });
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      '  Updated arrival  ',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save day' }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Save day' }),
    );

    await waitFor(() => expect(mockPatchSection).toHaveBeenCalledTimes(1));
    expect(mockPatchSection).toHaveBeenCalledWith(TRIP_ID, SECTION_ID, {
      label: 'Updated arrival',
    });
    expect(mockLatestStackOptions?.gestureEnabled).toBe(false);
    expect(
      screen.getByRole('button', {
        name: 'Cancel timeline day form',
      }).props.accessibilityState,
    ).toMatchObject({ disabled: true });
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Cancel timeline day form',
      }),
    );
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ ...section, label: 'Updated arrival' });
    });
    await waitFor(() =>
      expect(mockRouter.dismissTo).toHaveBeenCalledWith(
        `/trips/${TRIP_ID}/timeline`,
      ),
    );
  });

  it('renders backend field and conflict detail verbatim and reconciles authority failures', async () => {
    mockCreateSection.mockRejectedValueOnce(
      axiosErrorWith(400, {
        label: ['Use the backend-approved day label.'],
      }),
    );
    await render(<SectionFormScreen />);
    await focusScreen();
    mockRefresh.mockClear();
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'First attempt',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );

    expect(
      await screen.findByText('Use the backend-approved day label.'),
    ).toBeTruthy();
    expect(mockRefresh).not.toHaveBeenCalled();

    mockCreateSection.mockRejectedValueOnce(
      axiosErrorWith(409, {
        detail: 'A timeline day already exists on this date.',
      }),
    );
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'Second attempt',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );

    expect(
      await screen.findByText(
        'A timeline day already exists on this date.',
      ),
    ).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith('silent');
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('ignores a late inactive failure without state, navigation, or event effects', async () => {
    const pending = deferred<TimelineSection>();
    mockCreateSection.mockReturnValue(pending.promise);
    await render(<SectionFormScreen />);
    const blur = await focusScreen();
    mockRefresh.mockClear();
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'Late failure',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
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
    expect(
      screen.getByRole('button', {
        name: 'Cancel timeline day form',
      }).props.accessibilityState,
    ).toMatchObject({ disabled: true });

    await focusScreen();
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Cancel timeline day form',
        }).props.accessibilityState,
      ).toMatchObject({ disabled: false }),
    );
    expect(mockLatestStackOptions?.gestureEnabled).toBe(true);
    expect(
      screen.queryByText('This late failure must remain invisible.'),
    ).toBeNull();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('recovers pending UI when an old mutation settles after refocus', async () => {
    const pending = deferred<TimelineSection>();
    mockCreateSection.mockReturnValue(pending.promise);
    await render(<SectionFormScreen />);
    const blur = await focusScreen();
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'Refocused failure',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );
    await waitFor(() =>
      expect(mockCreateSection).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      blur?.();
    });
    await focusScreen();
    expect(
      screen.getByRole('button', {
        name: 'Cancel timeline day form',
      }).props.accessibilityState,
    ).toMatchObject({ disabled: true });
    mockRefresh.mockClear();

    await act(async () => {
      pending.reject(
        axiosErrorWith(409, {
          detail: 'This stale generation must remain invisible.',
        }),
      );
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Cancel timeline day form',
        }).props.accessibilityState,
      ).toMatchObject({ disabled: false }),
    );
    expect(mockLatestStackOptions?.gestureEnabled).toBe(true);
    expect(
      screen.queryByText('This stale generation must remain invisible.'),
    ).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockPublishTimelineEvent).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('publishes one confirmed late success but does not reconcile or navigate the inactive screen', async () => {
    const pending = deferred<TimelineSection>();
    mockCreateSection.mockReturnValue(pending.promise);
    await render(<SectionFormScreen />);
    const blur = await focusScreen();
    mockRefresh.mockClear();
    await fireEvent.changeText(
      screen.getByLabelText('Day label'),
      'Late success',
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Add day' }),
    );

    await act(async () => {
      blur?.();
      pending.resolve({
        ...section,
        id: 'c11a834e-23f9-436e-83ad-fe69cc442b60',
      });
    });

    await waitFor(() =>
      expect(mockPublishTimelineEvent).toHaveBeenCalledTimes(1),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });
});
