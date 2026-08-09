import { normalizeNotification } from './api';
import type { NotificationItem } from './types';

export interface NotificationCreatedRealtimeEvent {
  type: 'notification';
  event: 'created';
  notification: NotificationItem;
}

export interface NotificationReadRealtimeEvent {
  type: 'notification';
  event: 'read';
  notification_ids: string[];
}

export interface NotificationReadAllRealtimeEvent {
  type: 'notification';
  event: 'read_all';
}

export type NotificationRealtimeEvent =
  | NotificationCreatedRealtimeEvent
  | NotificationReadRealtimeEvent
  | NotificationReadAllRealtimeEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNotificationActor(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return Boolean(
    isRecord(value) &&
      typeof value.id === 'string' &&
      typeof value.display_name === 'string' &&
      (value.identify_tag === null || typeof value.identify_tag === 'string'),
  );
}

function hasCreatedNotificationShape(value: unknown): value is Record<string, unknown> {
  return Boolean(
    isRecord(value) &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      typeof value.notification_type === 'string' &&
      value.notification_type.length > 0 &&
      isNotificationActor(value.actor) &&
      Object.prototype.hasOwnProperty.call(value, 'payload') &&
      typeof value.is_read === 'boolean' &&
      (value.read_at === null || typeof value.read_at === 'string') &&
      typeof value.created_at === 'string' &&
      value.created_at.length > 0,
  );
}

function normalizeNotificationIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of value) {
    if (typeof rawId !== 'string' || rawId.length === 0) {
      return null;
    }
    if (!seen.has(rawId)) {
      seen.add(rawId);
      uniqueIds.push(rawId);
    }
  }
  return uniqueIds;
}

export function parseNotificationRealtimeEvent(value: unknown): NotificationRealtimeEvent | null {
  if (!isRecord(value) || value.type !== 'notification') {
    return null;
  }

  switch (value.event) {
    case 'created': {
      if (!hasCreatedNotificationShape(value.notification)) {
        return null;
      }
      const notification = normalizeNotification(value.notification);
      return notification
        ? { type: 'notification', event: 'created', notification }
        : null;
    }
    case 'read': {
      const notificationIds = normalizeNotificationIds(value.notification_ids);
      return notificationIds
        ? { type: 'notification', event: 'read', notification_ids: notificationIds }
        : null;
    }
    case 'read_all':
      return { type: 'notification', event: 'read_all' };
    default:
      return null;
  }
}
