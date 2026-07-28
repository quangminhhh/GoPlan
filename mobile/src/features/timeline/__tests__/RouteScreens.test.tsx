let mockParams: Record<string, string | string[] | undefined> = {};
const mockRouter = {
  dismissTo: jest.fn(),
  push: jest.fn(),
};
const mockUseTimeline = jest.fn();
const mockUseTripDetail = jest.fn();
const mockUseFocusEffect = jest.fn();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useFocusEffect: (effect: () => (() => void) | void) =>
    mockUseFocusEffect(effect),
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../hooks/useTimeline', () => ({
  useTimeline: (...args: unknown[]) => mockUseTimeline(...args),
}));
jest.mock('@/features/trips/hooks/useTripDetail', () => ({
  useTripDetail: (...args: unknown[]) => mockUseTripDetail(...args),
}));

// eslint-disable-next-line import/first
import { render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { ActivityFormScreen } from '../screens/ActivityFormScreen';
// eslint-disable-next-line import/first
import { CustomTypeManagerScreen } from '../screens/CustomTypeManagerScreen';
// eslint-disable-next-line import/first
import { SectionFormScreen } from '../screens/SectionFormScreen';
// eslint-disable-next-line import/first
import { TimelineScreen } from '../screens/TimelineScreen';

const TRIP_ID = '123e4567-e89b-12d3-a456-426614174000';
const SECTION_ID = '2c1dfd8d-9c7f-43c7-9b99-71f6d1edda55';
const ACTIVITY_ID = 'a11957b3-3329-4fcf-9c7b-673a51c1d8a7';

describe('Timeline route screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    mockUseTripDetail.mockReturnValue({
      detail: {
        trip: {
          id: TRIP_ID,
          status: 'PLANNING',
        },
        my_membership: {
          role: 'CAPTAIN',
          status: 'ACTIVE',
          joined_at: '2026-01-01T00:00:00Z',
        },
        members: [],
      },
      status: 'ready',
      error: null,
      refreshing: false,
      refresh: jest.fn(),
    });
    mockUseTimeline.mockReturnValue({
      timeline: {
        trip_timezone: 'UTC',
        permissions: {
          can_edit_timeline: false,
          can_manage_custom_types: false,
          can_create_sections: false,
        },
        system_types: [],
        custom_types: [],
        sections: [],
      },
      status: 'ready',
      error: null,
      refreshing: false,
      refresh: jest.fn(),
      invalidate: jest.fn(),
    });
  });

  it('renders a neutral state for an invalid section form before mounting the valid shell', async () => {
    mockParams = { tripId: TRIP_ID, mode: 'edit', sectionId: [SECTION_ID] };
    await render(<SectionFormScreen />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(mockUseTimeline).not.toHaveBeenCalled();
  });

  it('renders a neutral state for a contradictory activity form intent', async () => {
    mockParams = {
      tripId: TRIP_ID,
      mode: 'edit',
      sectionId: SECTION_ID,
      activityId: ACTIVITY_ID,
    };
    await render(<ActivityFormScreen />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(screen.queryByTestId('activity-form-edit-route-ready')).toBeNull();
  });

  it('mounts the activity form shell only for a valid explicit intent', async () => {
    mockParams = { tripId: TRIP_ID, mode: 'edit', activityId: ACTIVITY_ID };
    mockUseTimeline.mockReturnValue({
      timeline: {
        trip_timezone: 'UTC',
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
        sections: [
          {
            id: SECTION_ID,
            section_date: '2026-06-01',
            label: 'Day 1',
            is_label_custom: false,
            is_in_trip_range: true,
            position: 0,
            activities: [
              {
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
              },
            ],
          },
        ],
      },
      status: 'ready',
      error: null,
      refreshing: false,
      refresh: jest.fn(),
      invalidate: jest.fn(),
    });
    await render(<ActivityFormScreen />);

    expect(screen.getByTestId('activity-form-scroll')).toBeTruthy();
    expect(screen.queryByText('Form unavailable')).toBeNull();
  });

  it('guards non-form timeline routes with the same strict trip UUID parser', async () => {
    mockParams = { tripId: [TRIP_ID] };
    const { rerender } = await render(<TimelineScreen />);
    expect(screen.getByText('Timeline unavailable')).toBeTruthy();
    expect(mockUseTimeline).not.toHaveBeenCalled();

    mockParams = { tripId: 'not-a-uuid' };
    await rerender(<CustomTypeManagerScreen />);
    expect(screen.getByText('Custom types unavailable')).toBeTruthy();

    mockParams = { tripId: TRIP_ID };
    await rerender(<TimelineScreen />);
    expect(screen.getByTestId('timeline-route-ready')).toBeTruthy();
    expect(mockUseTimeline).toHaveBeenCalledWith(TRIP_ID);
  });
});
