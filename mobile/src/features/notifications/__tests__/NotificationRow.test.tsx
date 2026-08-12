import { fireEvent, render, screen } from '@testing-library/react-native';
import { NotificationRow } from '../components/NotificationRow';
import type { NotificationItem } from '../types';

const invitationPayload = {
  trip_id: 'trip-1',
  trip_name: 'Da Lat escape',
  destination: 'Da Lat',
  start_date: '2026-08-01',
  end_date: '2026-08-03',
  invitation_id: 'invitation-1',
  invitation_status: 'PENDING',
};

const base: NotificationItem = {
  id: 'notification-1',
  notification_type: 'FRIEND_REQUEST',
  actor: { id: 'user-2', display_name: 'Bob', identify_tag: 'bob#ABC123' },
  payload: {},
  is_read: false,
  read_at: null,
  created_at: '2026-07-22T01:00:00Z',
};

const defaultProps = {
  readPending: false,
  pendingInvitationAction: null,
  error: null,
  onOpen: jest.fn(),
  onInvitationAction: jest.fn(),
};

describe('NotificationRow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders a known simple notification and marks it through the row action', async () => {
    const onOpen = jest.fn();
    await render(<NotificationRow {...defaultProps} notification={base} onOpen={onOpen} />);

    expect(screen.getByText('Bob sent you a friend request')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Bob sent you a friend request' }));
    expect(onOpen).toHaveBeenCalledWith('notification-1', null);
  });

  it('exposes the current read state once on the simple row action', async () => {
    const { rerender } = await render(<NotificationRow {...defaultProps} notification={base} />);

    const label = 'Bob sent you a friend request';
    expect(screen.getByRole('button', { name: label }).props.accessibilityValue).toEqual({
      text: 'Unread',
    });
    expect(screen.queryByLabelText('Unread')).toBeNull();

    await rerender(
      <NotificationRow {...defaultProps} notification={{ ...base, is_read: true }} />,
    );

    expect(screen.getByRole('button', { name: label }).props.accessibilityValue).toEqual({
      text: 'Read',
    });
    expect(screen.queryByLabelText('Unread')).toBeNull();
  });

  it('renders malformed and unknown payloads neutrally without exposing raw JSON', async () => {
    await render(
      <NotificationRow
        {...defaultProps}
        notification={{ ...base, notification_type: 'NEW_SECRET_TYPE', payload: { token: 'do-not-show' } }}
      />,
    );

    expect(screen.getByText('You have a new notification')).toBeTruthy();
    expect(screen.getByText('Details are unavailable.')).toBeTruthy();
    expect(screen.queryByText(/do-not-show/)).toBeNull();
    expect(screen.queryByText(/NEW_SECRET_TYPE/)).toBeNull();
  });

  it('shows both pending invitation actions and disables them through one shared pending state', async () => {
    const onAction = jest.fn();
    await render(
      <NotificationRow
        {...defaultProps}
        notification={{ ...base, notification_type: 'TRIP_INVITATION', payload: invitationPayload }}
        pendingInvitationAction="accept"
        onInvitationAction={onAction}
      />,
    );

    const accept = screen.getByRole('button', { name: 'Accept' });
    const decline = screen.getByRole('button', { name: 'Decline' });
    expect(accept.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true, busy: true }));
    expect(decline.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    await fireEvent.press(decline);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('dispatches invitation identity and only opens an accepted invitation trip', async () => {
    const onAction = jest.fn();
    const onOpen = jest.fn();
    const { rerender } = await render(
      <NotificationRow
        {...defaultProps}
        notification={{ ...base, notification_type: 'TRIP_INVITATION', payload: invitationPayload }}
        onInvitationAction={onAction}
        onOpen={onOpen}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Accept' }));
    expect(onAction).toHaveBeenCalledWith('notification-1', 'invitation-1', 'trip-1', 'accept');
    await fireEvent.press(screen.getByRole('button', { name: 'Trip invitation to Da Lat escape' }));
    expect(onOpen).toHaveBeenCalledWith('notification-1', null);

    await rerender(
      <NotificationRow
        {...defaultProps}
        notification={{
          ...base,
          notification_type: 'TRIP_INVITATION',
          payload: { ...invitationPayload, invitation_status: 'ACCEPTED' },
        }}
        onInvitationAction={onAction}
        onOpen={onOpen}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByText('You joined this trip.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Trip invitation to Da Lat escape' }));
    expect(onOpen).toHaveBeenLastCalledWith('notification-1', 'trip-1');
  });

  it('exposes the current read state once on the invitation row action', async () => {
    const invitation: NotificationItem = {
      ...base,
      notification_type: 'TRIP_INVITATION',
      payload: invitationPayload,
    };
    const { rerender } = await render(
      <NotificationRow {...defaultProps} notification={invitation} />,
    );

    const label = 'Trip invitation to Da Lat escape';
    expect(screen.getByRole('button', { name: label }).props.accessibilityValue).toEqual({
      text: 'Unread',
    });
    expect(screen.queryByLabelText('Unread')).toBeNull();

    await rerender(
      <NotificationRow
        {...defaultProps}
        notification={{ ...invitation, is_read: true }}
      />,
    );

    expect(screen.getByRole('button', { name: label }).props.accessibilityValue).toEqual({
      text: 'Read',
    });
    expect(screen.queryByLabelText('Unread')).toBeNull();
  });

  it('keeps legacy invitation status non-actionable and displays normalized row errors', async () => {
    await render(
      <NotificationRow
        {...defaultProps}
        notification={{
          ...base,
          notification_type: 'TRIP_INVITATION',
          payload: { ...invitationPayload, invitation_status: undefined },
        }}
        error={{ kind: 'message', message: 'This invitation is no longer pending.', status: 409 }}
      />,
    );

    expect(screen.getByText('Invitation status is unavailable.')).toBeTruthy();
    expect(screen.getByText('This invitation is no longer pending.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});
