import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import { Pressable, Text } from 'react-native';
import type { TripMember } from '@/features/trips/types';
import { ActivityForm } from '../components/ActivityForm';
import {
  ACTIVITY_FIELD_LIMITS,
  createActivityDraft,
  type ActivityFormDraft,
} from '../formModel';
import type {
  TimelineActivity,
  TimelineCustomTypeMeta,
  TimelineSystemTypeMeta,
} from '../types';

const systemTypes: TimelineSystemTypeMeta[] = [
  {
    code: 'FOOD',
    label: 'Food',
    color_token: 'amber',
    icon_key: 'restaurant',
  },
  {
    code: 'OTHER',
    label: 'Other',
    color_token: 'slate',
    icon_key: 'tag',
  },
];

const customTypes: TimelineCustomTypeMeta[] = [
  {
    id: 'custom-active',
    name: 'Coffee stop',
    normalized_name: 'coffee-stop',
    color_token: 'amber',
    icon_key: 'cafe',
    is_active: true,
  },
];

const members: TripMember[] = [
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
];

function validDraft(
  overrides: Partial<ActivityFormDraft> = {},
): ActivityFormDraft {
  return {
    ...createActivityDraft(),
    title: 'Breakfast',
    start_time: '08:30',
    system_type: 'FOOD',
    ...overrides,
  };
}

function buildActivity(
  overrides: Partial<TimelineActivity> = {},
): TimelineActivity {
  return {
    id: 'activity-1',
    title: 'Breakfast',
    time_mode: 'AT_TIME',
    start_time: '08:30:00',
    end_time: null,
    status: 'UPCOMING',
    position: 0,
    activity_type: {
      kind: 'SYSTEM',
      code: 'FOOD',
      label: 'Food',
      color_token: 'amber',
      icon_key: 'restaurant',
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

function renderForm(
  overrides: Partial<ComponentProps<typeof ActivityForm>> = {},
) {
  const props: ComponentProps<typeof ActivityForm> = {
    mode: 'create',
    draft: validDraft(),
    systemTypes,
    customTypes,
    members,
    canManageCustomTypes: true,
    canSubmit: true,
    submitting: false,
    refreshing: false,
    localFieldErrors: {},
    submitError: null,
    backgroundError: null,
    onDraftChange: jest.fn(),
    onSubmit: jest.fn(),
    onRefresh: jest.fn(),
    onRetryBackground: jest.fn(),
    onManageCustomTypes: jest.fn(),
    ...overrides,
  };
  return { props, view: render(<ActivityForm {...props} />) };
}

describe('ActivityForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all draft fields, virtualized choices, caps, and server reminder boundary', async () => {
    await renderForm().view;

    expect(screen.getByTestId('custom-type-list')).toBeTruthy();
    expect(screen.getByTestId('assignee-member-list')).toBeTruthy();
    expect(screen.getByLabelText('Activity title').props.maxLength).toBe(
      ACTIVITY_FIELD_LIMITS.title,
    );
    expect(screen.getByLabelText('Location label').props.maxLength).toBe(
      ACTIVITY_FIELD_LIMITS.location_label,
    );
    expect(screen.getByLabelText('Meeting point')).toBeTruthy();
    expect(screen.getByLabelText('Contact name')).toBeTruthy();
    expect(screen.getByLabelText('Contact phone')).toBeTruthy();
    expect(screen.getByLabelText('Booking reference')).toBeTruthy();
    expect(screen.getByLabelText('External link')).toBeTruthy();
    expect(screen.getByLabelText('Reminder 30 min before')).toBeTruthy();
    expect(
      screen.getByText(/does not schedule device notifications/i),
    ).toBeTruthy();
  });

  it('applies time-mode invariants before reporting the changed fields', async () => {
    const onDraftChange = jest.fn();
    await renderForm({
      draft: validDraft({
        time_mode: 'TIME_RANGE',
        start_time: '08:30',
        end_time: '09:30',
        reminder_offsets_minutes: [30],
      }),
      onDraftChange,
    }).view;

    await fireEvent.press(screen.getByLabelText('Schedule All day'));

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        time_mode: 'ALL_DAY',
        start_time: '',
        end_time: '',
        reminder_offsets_minutes: [],
      }),
      [
        'time_mode',
        'start_time',
        'end_time',
        'reminder_offsets_minutes',
      ],
    );
  });

  it('keeps only the inactive custom type selected by the edited activity', async () => {
    const inactiveCurrent: TimelineCustomTypeMeta = {
      id: 'inactive-current',
      name: 'Legacy stop',
      normalized_name: 'legacy-stop',
      color_token: 'slate',
      icon_key: 'tag',
      is_active: false,
    };
    const inactiveOther: TimelineCustomTypeMeta = {
      ...inactiveCurrent,
      id: 'inactive-other',
      name: 'Unused legacy',
      normalized_name: 'unused-legacy',
    };
    const initialActivity = buildActivity({
      activity_type: {
        kind: 'CUSTOM',
        id: inactiveCurrent.id,
        label: inactiveCurrent.name,
        color_token: inactiveCurrent.color_token,
        icon_key: inactiveCurrent.icon_key,
      },
    });
    await renderForm({
      mode: 'edit',
      draft: validDraft({
        system_type: null,
        custom_type_id: inactiveCurrent.id,
      }),
      customTypes: [...customTypes, inactiveCurrent, inactiveOther],
      initialActivity,
    }).view;

    expect(screen.getByText('Legacy stop · inactive')).toBeTruthy();
    expect(screen.queryByText('Unused legacy · inactive')).toBeNull();
  });

  it('uses horizontal active-member choices to build USER assignee state', async () => {
    const onDraftChange = jest.fn();
    await renderForm({ onDraftChange }).view;

    await fireEvent.press(screen.getByLabelText('Assign to Minh'));

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_scope: 'USER',
        assignee_user_id: 'member-1',
      }),
      ['assignee_scope', 'assignee_user_id'],
    );
  });

  it('clears structured place only through an explicit manual switch', async () => {
    const onDraftChange = jest.fn();
    await renderForm({
      draft: validDraft({
        location_mode: 'STRUCTURED',
        location_label: 'Verified cafe',
        place: {
          provider: 'here',
          provider_id: 'canonical-id',
          title: 'Verified cafe',
          address: 'Da Nang',
          lat: 16,
          lng: 108,
        },
      }),
      onDraftChange,
    }).view;

    await fireEvent.press(screen.getByLabelText('Use manual location'));

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        location_mode: 'MANUAL',
        place: null,
      }),
      ['location_mode', 'place'],
    );
  });

  it('exposes a canonical structured-location integration seam', async () => {
    const onDraftChange = jest.fn();
    await renderForm({
      onDraftChange,
      renderStructuredLocationEditor: ({ onChange }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose verified place"
          onPress={() =>
            onChange({
              location_label: 'Canonical title',
              place: {
                provider: 'here',
                provider_id: 'canonical-lookup-id',
                title: 'Canonical title',
                address: 'Canonical address',
                lat: 16,
                lng: 108,
              },
            })
          }
        >
          <Text>Choose verified place</Text>
        </Pressable>
      ),
    }).view;

    await fireEvent.press(screen.getByLabelText('Choose verified place'));

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        location_mode: 'STRUCTURED',
        location_label: 'Canonical title',
        place: expect.objectContaining({
          provider_id: 'canonical-lookup-id',
        }),
      }),
      ['location_mode', 'location_label', 'place'],
    );
  });

  it('renders location_label and every nested place error inline', async () => {
    await renderForm({
      draft: validDraft({
        location_mode: 'STRUCTURED',
        location_label: 'Verified cafe',
        place: {
          provider: 'here',
          provider_id: 'canonical-id',
          title: 'Verified cafe',
          address: '',
          lat: null,
          lng: null,
        },
      }),
      submitError: {
        kind: 'field',
        message: 'Please fix the highlighted fields.',
        fieldErrors: {
          location_label: 'Location label is invalid.',
          'place.provider_id': 'Provider id is invalid.',
          'place.title': 'Place title is invalid.',
          'place.extra': 'Unknown nested place issue.',
        },
      },
    }).view;

    expect(screen.getByText('Location label is invalid.')).toBeTruthy();
    expect(screen.getByText('Provider id is invalid.')).toBeTruthy();
    expect(screen.getByText('Place title is invalid.')).toBeTruthy();
    expect(screen.getByText('Unknown nested place issue.')).toBeTruthy();
  });

  it('toggles only supported reminder presets through the pure form model', async () => {
    const onDraftChange = jest.fn();
    await renderForm({ onDraftChange }).view;

    await fireEvent.press(screen.getByLabelText('Reminder 30 min before'));

    expect(onDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        reminder_offsets_minutes: [30],
      }),
      ['reminder_offsets_minutes'],
    );
  });

  it('disables editing and submit controls after authority is lost', async () => {
    await renderForm({
      canSubmit: false,
      authorityMessage: 'You no longer have permission.',
    }).view;

    expect(screen.getByLabelText('Activity title').props.editable).toBe(false);
    expect(
      screen.getByLabelText('System type Food').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      screen.getByLabelText('Create activity').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(screen.getByText('You no longer have permission.')).toBeTruthy();
  });
});
