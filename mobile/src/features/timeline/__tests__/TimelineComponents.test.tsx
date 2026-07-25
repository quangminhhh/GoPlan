const mockIonicons = jest.fn((_props: unknown) => null);

jest.mock('@expo/vector-icons', () => ({
  Ionicons: (props: unknown) => mockIonicons(props),
}));

// eslint-disable-next-line import/first
import { Linking } from 'react-native';
// eslint-disable-next-line import/first
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { ActivityRow } from '../components/ActivityRow';
// eslint-disable-next-line import/first
import { SectionGroup } from '../components/SectionGroup';
// eslint-disable-next-line import/first
import type { TimelineActivity, TimelineSection } from '../types';

function buildActivity(
  overrides: Partial<TimelineActivity> = {},
): TimelineActivity {
  return {
    id: 'activity-1',
    title: 'Airport transfer',
    time_mode: 'TIME_RANGE',
    start_time: '09:05:00',
    end_time: '10:30:00',
    status: 'UPCOMING',
    position: 0,
    activity_type: {
      kind: 'SYSTEM',
      code: 'TRANSPORTATION',
      label: 'Transportation',
      color_token: 'sky',
      icon_key: 'bus',
    },
    assignee_scope: 'USER',
    assignee: {
      id: 'user-1',
      display_name: 'Quang Minh',
      identify_tag: 'minh#1234',
    },
    location: {
      location_mode: 'STRUCTURED',
      location_label: 'Da Nang International Airport',
      location_note: 'Meet at column 5.',
      place: {
        provider: 'here',
        provider_id: 'here:place:airport',
        title: 'Da Nang International Airport',
        address: 'Da Nang, Vietnam',
        lat: 16.0439,
        lng: 108.199,
      },
      open_url: 'https://maps.example/airport',
    },
    note: 'Driver holds a GoPlan sign.',
    meeting_point: 'Arrival hall',
    contact_name: 'Anh Tran',
    contact_phone: '+84 900 000 000',
    booking_reference: 'CAR-2026',
    external_link: 'https://booking.example/CAR-2026',
    reminder_offsets_minutes: [120, 30],
    capabilities: {
      can_edit: true,
      can_delete: true,
      can_update_status: true,
    },
    ...overrides,
  };
}

function buildSection(
  overrides: Partial<TimelineSection> = {},
): TimelineSection {
  return {
    id: 'section-1',
    section_date: '2026-05-31',
    label: 'Arrival',
    is_label_custom: true,
    is_in_trip_range: true,
    position: 0,
    activities: [],
    ...overrides,
  };
}

describe('ActivityRow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders unknown type tokens and icons with neutral fallbacks', async () => {
    await render(
      <ActivityRow
        activity={buildActivity({
          activity_type: {
            kind: 'CUSTOM',
            id: 'custom-1',
            label: 'Future type',
            color_token: 'future-color',
            icon_key: 'future-icon',
          },
        })}
      />,
    );

    expect(screen.getByText('Future type')).toBeTruthy();
    expect(screen.getByText('09:05 – 10:30')).toBeTruthy();
    expect(
      mockIonicons.mock.calls.some(
        ([props]) =>
          (props as { name?: string }).name === 'pricetag-outline',
      ),
    ).toBe(true);
  });

  it('expands and collapses optional activity details in place', async () => {
    await render(<ActivityRow activity={buildActivity()} />);

    expect(screen.queryByText('Driver holds a GoPlan sign.')).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Expand Airport transfer details',
      }),
    );

    expect(screen.getByText('Driver holds a GoPlan sign.')).toBeTruthy();
    expect(screen.getByText('Arrival hall')).toBeTruthy();
    expect(screen.getByText('Anh Tran')).toBeTruthy();
    expect(screen.getByText('CAR-2026')).toBeTruthy();
    expect(screen.getByText('2 hours before, 30 minutes before')).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Collapse Airport transfer details',
      }),
    );
    expect(screen.queryByText('Driver holds a GoPlan sign.')).toBeNull();
  });

  it('shows a non-blocking notice when a location URL is unsupported', async () => {
    const canOpenUrl = jest
      .spyOn(Linking, 'canOpenURL')
      .mockResolvedValue(false);
    const openUrl = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined);
    await render(<ActivityRow activity={buildActivity()} />);

    await fireEvent.press(
      screen.getByRole('link', {
        name: 'Open directions to Da Nang International Airport',
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText('Could not open this link. Try again later.'),
      ).toBeTruthy(),
    );
    expect(canOpenUrl).toHaveBeenCalledWith('https://maps.example/airport');
    expect(openUrl).not.toHaveBeenCalled();
    expect(screen.getByText('Airport transfer')).toBeTruthy();
  });

  it('shows the same notice when opening an external activity link rejects', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const openUrl = jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('Native open failed.'));
    await render(<ActivityRow activity={buildActivity()} />);

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Expand Airport transfer details',
      }),
    );
    await fireEvent.press(
      screen.getByRole('link', {
        name: 'Open link for Airport transfer',
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText('Could not open this link. Try again later.'),
      ).toBeTruthy(),
    );
    expect(openUrl).toHaveBeenCalledWith(
      'https://booking.example/CAR-2026',
    );
  });

  it('gates Edit and Delete independently on per-activity capabilities', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const { rerender } = await render(
      <ActivityRow
        activity={buildActivity({
          capabilities: {
            can_edit: false,
            can_delete: true,
            can_update_status: false,
          },
        })}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Edit Airport transfer' }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Airport transfer' }),
    );
    expect(onDelete).toHaveBeenCalledWith('activity-1');

    await rerender(
      <ActivityRow
        activity={buildActivity({
          capabilities: {
            can_edit: true,
            can_delete: false,
            can_update_status: false,
          },
        })}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Delete Airport transfer' }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Edit Airport transfer' }),
    );
    expect(onEdit).toHaveBeenCalledWith('activity-1');
  });

  it('renders status controls in expanded details and forwards the activity id', async () => {
    const onChangeStatus = jest.fn().mockResolvedValue(undefined);
    await render(
      <ActivityRow
        activity={buildActivity()}
        onChangeStatus={onChangeStatus}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Start activity' }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Expand Airport transfer details',
      }),
    );
    await fireEvent.press(
      screen.getByRole('button', { name: 'Start activity' }),
    );
    await waitFor(() =>
      expect(onChangeStatus).toHaveBeenCalledWith(
        'activity-1',
        'IN_PROGRESS',
      ),
    );
  });

  it('disables visible edit and delete controls during another mutation', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    await render(
      <ActivityRow
        activity={buildActivity()}
        actionsDisabled
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    const edit = screen.getByRole('button', {
      name: 'Edit Airport transfer',
    });
    const remove = screen.getByRole('button', {
      name: 'Delete Airport transfer',
    });
    expect(edit.props.accessibilityState).toEqual({ disabled: true });
    expect(remove.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(edit);
    await fireEvent.press(remove);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('SectionGroup', () => {
  it('formats the date and shows the section range marker', async () => {
    const { rerender } = await render(
      <SectionGroup section={buildSection()} />,
    );

    expect(screen.getByRole('header', { name: 'Arrival' })).toBeTruthy();
    expect(screen.getByText('Sun, May 31, 2026')).toBeTruthy();
    expect(screen.getByText('Trip date')).toBeTruthy();

    await rerender(
      <SectionGroup
        section={buildSection({ is_in_trip_range: false })}
      />,
    );
    expect(screen.getByText('Outside trip')).toBeTruthy();
  });

  it('gates section actions only on aggregate-level flags', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    await render(
      <SectionGroup
        section={buildSection()}
        canEdit={false}
        canDelete
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Edit Arrival' }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Delete Arrival' }),
    );
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'section-1' }),
    );
  });

  it('disables all visible section actions while a mutation is locked', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    await render(
      <SectionGroup
        section={buildSection()}
        canEdit
        canDelete
        actionsDisabled
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    const edit = screen.getByRole('button', { name: 'Edit Arrival' });
    const remove = screen.getByRole('button', { name: 'Delete Arrival' });
    expect(edit.props.accessibilityState).toEqual({ disabled: true });
    expect(remove.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(edit);
    await fireEvent.press(remove);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
