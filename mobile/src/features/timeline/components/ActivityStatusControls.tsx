import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import type {
  TimelineActivity,
  TimelineActivityStatus,
} from '../types';

interface ActivityStatusControlsProps {
  activity: TimelineActivity;
  onChangeStatus: (nextStatus: TimelineActivityStatus) => Promise<void>;
  disabled?: boolean;
  error?: ApiError | null;
  onSettledFailure?: (error: ApiError) => void;
}

interface StatusAction {
  status: TimelineActivityStatus;
  label: string;
}

interface OwnedErrorState {
  activityStateKey: string;
  error: ApiError;
}

const BASE_TRANSITIONS: Record<
  TimelineActivityStatus,
  readonly TimelineActivityStatus[]
> = {
  UPCOMING: ['IN_PROGRESS'],
  IN_PROGRESS: ['UPCOMING', 'DONE'],
  DONE: [],
  CANCELLED: [],
};

const EDIT_TRANSITIONS: Record<
  TimelineActivityStatus,
  readonly TimelineActivityStatus[]
> = {
  UPCOMING: ['DONE', 'CANCELLED'],
  IN_PROGRESS: ['CANCELLED'],
  DONE: ['IN_PROGRESS', 'UPCOMING', 'CANCELLED'],
  CANCELLED: ['UPCOMING'],
};

function getActionLabel(
  currentStatus: TimelineActivityStatus,
  nextStatus: TimelineActivityStatus,
): string {
  if (nextStatus === 'DONE') {
    return 'Mark done';
  }
  if (nextStatus === 'CANCELLED') {
    return 'Cancel activity';
  }
  if (currentStatus === 'UPCOMING' && nextStatus === 'IN_PROGRESS') {
    return 'Start activity';
  }
  if (currentStatus === 'DONE' && nextStatus === 'IN_PROGRESS') {
    return 'Reopen activity';
  }
  if (currentStatus === 'CANCELLED' && nextStatus === 'UPCOMING') {
    return 'Restore activity';
  }
  return 'Reset to upcoming';
}

export function getActivityStatusActions(
  activity: Pick<TimelineActivity, 'status' | 'capabilities'>,
): StatusAction[] {
  if (!activity.capabilities.can_update_status) {
    return [];
  }

  const statuses = activity.capabilities.can_edit
    ? [
        ...BASE_TRANSITIONS[activity.status],
        ...EDIT_TRANSITIONS[activity.status],
      ]
    : BASE_TRANSITIONS[activity.status];
  const seen = new Set<TimelineActivityStatus>();

  return statuses.flatMap((status) => {
    if (seen.has(status)) {
      return [];
    }
    seen.add(status);
    return [
      {
        status,
        label: getActionLabel(activity.status, status),
      },
    ];
  });
}

export function ActivityStatusControls({
  activity,
  onChangeStatus,
  disabled = false,
  error,
  onSettledFailure,
}: ActivityStatusControlsProps) {
  const [ownedError, setOwnedError] = useState<OwnedErrorState | null>(null);
  const [pendingStatus, setPendingStatus] =
    useState<TimelineActivityStatus | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const ownsError = error === undefined;
  const activityStateKey = `${activity.id}:${activity.status}`;
  const actions = useMemo(
    () => getActivityStatusActions(activity),
    [activity],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestStatusChange = useCallback(
    async (nextStatus: TimelineActivityStatus) => {
      if (disabled || inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;
      if (ownsError) {
        setOwnedError(null);
      }
      setPendingStatus(nextStatus);

      try {
        await onChangeStatus(nextStatus);
      } catch (caught) {
        const nextError = normalizeApiError(caught);
        if (mountedRef.current) {
          if (ownsError) {
            setOwnedError({ activityStateKey, error: nextError });
          }
          onSettledFailure?.(nextError);
        }
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setPendingStatus(null);
        }
      }
    },
    [
      activityStateKey,
      disabled,
      onChangeStatus,
      onSettledFailure,
      ownsError,
    ],
  );

  if (actions.length === 0) {
    return null;
  }

  const displayError = ownsError
    ? ownedError?.activityStateKey === activityStateKey
      ? ownedError.error
      : null
    : error;

  return (
    <View accessibilityLabel="Activity status controls" style={styles.wrap}>
      <View style={styles.actions}>
        {actions.map((action) => (
          <View key={action.status} style={styles.action}>
            <Button
              title={action.label}
              variant="secondary"
              disabled={disabled || pendingStatus !== null}
              loading={pendingStatus === action.status}
              onPress={() => {
                void requestStatusChange(action.status);
              }}
            />
          </View>
        ))}
      </View>
      {displayError ? (
        <View accessibilityRole="alert" style={styles.error}>
          <Text style={styles.errorText}>{displayError.message}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  action: { minWidth: 132, flexGrow: 1 },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  errorText: { ...typography.caption, color: colors.danger },
});
