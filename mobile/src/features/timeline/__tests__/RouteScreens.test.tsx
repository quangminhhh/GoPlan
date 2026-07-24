let mockParams: Record<string, string | string[] | undefined> = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

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
    mockParams = {};
  });

  it('renders a neutral state for an invalid section form before mounting the valid shell', async () => {
    mockParams = { tripId: TRIP_ID, mode: 'edit', sectionId: [SECTION_ID] };
    await render(<SectionFormScreen />);

    expect(screen.getByText('Form unavailable')).toBeTruthy();
    expect(screen.queryByTestId('section-form-edit-route-ready')).toBeNull();
  });

  it('mounts the section form shell only for a valid explicit intent', async () => {
    mockParams = { tripId: TRIP_ID, mode: 'create' };
    await render(<SectionFormScreen />);

    expect(screen.getByTestId('section-form-create-route-ready')).toBeTruthy();
    expect(screen.queryByText('Form unavailable')).toBeNull();
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
    await render(<ActivityFormScreen />);

    expect(screen.getByTestId('activity-form-edit-route-ready')).toBeTruthy();
    expect(screen.queryByText('Form unavailable')).toBeNull();
  });

  it('guards non-form timeline routes with the same strict trip UUID parser', async () => {
    mockParams = { tripId: [TRIP_ID] };
    const { rerender } = await render(<TimelineScreen />);
    expect(screen.getByText('Timeline unavailable')).toBeTruthy();

    mockParams = { tripId: 'not-a-uuid' };
    await rerender(<CustomTypeManagerScreen />);
    expect(screen.getByText('Custom types unavailable')).toBeTruthy();

    mockParams = { tripId: TRIP_ID };
    await rerender(<TimelineScreen />);
    expect(screen.getByTestId('timeline-route-ready')).toBeTruthy();
  });
});
