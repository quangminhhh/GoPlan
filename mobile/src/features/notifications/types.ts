import type { ApiError } from '@/shared/api/errors';

export const NOTIFICATION_TYPES = [
  'FRIEND_REQUEST',
  'FRIEND_ACCEPTED',
  'TRIP_INVITATION',
  'TRIP_INVITATION_ACCEPTED',
  'TRIP_INVITATION_DECLINED',
  'TRIP_CANCELLED',
  'TRIP_MEMBER_REMOVED',
  'TRIP_TIMELINE_REMINDER',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';

export interface NotificationActor {
  id: string;
  display_name: string;
  identify_tag: string | null;
}

export interface NotificationItem {
  id: string;
  notification_type: string;
  actor: NotificationActor | null;
  payload: unknown;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

export type NotificationListStatus = 'loading' | 'ready' | 'error';
export type NotificationLoadMode = 'initial' | 'refresh' | 'silent';
export type NotificationErrorSource = 'initial' | 'refresh' | 'loadMore' | null;
export type InvitationAction = 'accept' | 'decline';

export interface TripInvitationPayload {
  trip_id: string;
  trip_name: string;
  destination: string;
  start_date: string;
  end_date: string;
  invitation_id: string;
  invitation_status: InvitationStatus | null;
}

export interface TripResponsePayload {
  trip_id: string;
  trip_name: string;
  responder_name: string | null;
}

export interface TripPayload {
  trip_id: string;
  trip_name: string;
}

export interface TripTimelineReminderPayload extends TripPayload {
  activity_id: string;
  activity_title: string;
  section_label: string;
  activity_date: string;
  activity_time: string;
  location_label: string;
}

export type ParsedNotificationPayload =
  | { kind: 'friendRequest' }
  | { kind: 'friendAccepted' }
  | { kind: 'tripInvitation'; invitation: TripInvitationPayload }
  | { kind: 'tripInvitationAccepted'; response: TripResponsePayload }
  | { kind: 'tripInvitationDeclined'; response: TripResponsePayload }
  | { kind: 'tripCancelled'; trip: TripPayload }
  | { kind: 'tripMemberRemoved'; trip: TripPayload }
  | { kind: 'tripTimelineReminder'; reminder: TripTimelineReminderPayload }
  | { kind: 'fallback' };

export interface NotificationOverride {
  version: number;
  isRead?: boolean;
  invitationStatus?: InvitationStatus | null;
}

export interface NotificationsContextValue {
  items: NotificationItem[];
  status: NotificationListStatus;
  error: ApiError | null;
  errorSource: NotificationErrorSource;
  refreshing: boolean;
  loadingMore: boolean;
  hasNextPage: boolean;
  unreadCount: number | null;
  /** Last authoritative count, retained only for degraded badge affordances while `unreadCount` is unknown. */
  lastKnownUnreadCount: number | null;
  markingAllRead: boolean;
  pendingReadIds: ReadonlySet<string>;
  pendingInvitationActions: ReadonlyMap<string, InvitationAction>;
  rowErrors: ReadonlyMap<string, ApiError>;
  globalMutationError: ApiError | null;
  refreshForFocus: () => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (notificationId: string) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
  respondToInvitation: (
    notificationId: string,
    invitationId: string,
    tripId: string,
    action: InvitationAction,
  ) => Promise<boolean>;
}
