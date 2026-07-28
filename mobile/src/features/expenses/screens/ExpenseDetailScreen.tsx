import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTripDetail } from '@/features/trips/hooks/useTripDetail';
import type { ApiError } from '@/shared/api/errors';
import { normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { getExpenseItemActions } from '../actions';
import {
  deleteExpense,
  setContribution,
} from '../api';
import { ContributionEditor } from '../components/ContributionEditor';
import { publishExpenseEvent } from '../expenseEvents';
import { buildContributionPayload } from '../formModel';
import { useExpenseCompositionCoordinator } from '../hooks/useExpenseCompositionCoordinator';
import { useExpenseDetail } from '../hooks/useExpenseDetail';
import {
  formatExpenseMoney,
  getExpenseStatusLabel,
  getExpenseStatusTone,
} from '../money';
import {
  parseExpenseDetailRouteIntent,
  type ExpenseDetailRouteIntent,
} from '../routeIntent';
import type {
  ExpenseDetailResponse,
  ExpenseParticipant,
} from '../types';
import { RouteUnavailableState } from './RouteState';

function formatLockedAt(
  value: string | null,
  timeZone: string,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }
}

function HeaderEditAction({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Edit expense"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={spacing.sm}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerAction,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={styles.headerActionText}>Edit</Text>
    </Pressable>
  );
}

function DetailMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'danger' | 'success' | 'warning';
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text
        style={[
          styles.metricValue,
          tone === 'danger' ? styles.dangerText : null,
          tone === 'success' ? styles.successText : null,
          tone === 'warning' ? styles.warningText : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

interface HydratedExpenseDetailProps {
  intent: ExpenseDetailRouteIntent;
  detail: ExpenseDetailResponse;
  tripDetail: NonNullable<
    ReturnType<typeof useTripDetail>['detail']
  >;
  detailError: ApiError | null;
  tripError: ApiError | null;
  refreshing: boolean;
  refreshAll: (
    mode: 'initial' | 'refresh' | 'silent',
  ) => Promise<void>;
  requestReconcile: (forceInitial?: boolean) => Promise<void>;
  invalidateDetail: () => void;
  isScreenActive: () => boolean;
}

function HydratedExpenseDetail({
  intent,
  detail,
  tripDetail,
  detailError,
  tripError,
  refreshing,
  refreshAll,
  requestReconcile,
  invalidateDetail,
  isScreenActive,
}: HydratedExpenseDetailProps) {
  const router = useRouter();
  const contributionLocksRef = useRef(new Set<string>());
  const deleteAlertLockRef = useRef(false);
  const mountedRef = useRef(true);
  const [draftAmounts, setDraftAmounts] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      detail.participants.map((participant) => [
        participant.user_id,
        participant.contributed_amount,
      ]),
    ),
  );
  const [editingUserIds, setEditingUserIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [pendingUserIds, setPendingUserIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [contributionErrors, setContributionErrors] = useState<
    Record<string, string>
  >({});
  const [amountErrors, setAmountErrors] = useState<
    Record<string, string>
  >({});
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(
    null,
  );

  const actions = getExpenseItemActions({
    canManageExpenses:
      tripDetail.my_membership.status === 'ACTIVE' &&
      detail.permissions.can_manage_expenses,
    tripStatus: tripDetail.trip.status,
    locked: detail.locked,
  });
  const parentHref = `/trips/${intent.tripId}/expenses` as const;

  useEffect(
    () => () => {
      mountedRef.current = false;
      contributionLocksRef.current.clear();
      deleteAlertLockRef.current = false;
    },
    [],
  );

  const openEditForm = useCallback(() => {
    if (actions.canEditExpense) {
      router.push(
        `/trips/${intent.tripId}/expenses/expense-form?mode=edit&expenseId=${intent.expenseId}`,
      );
    }
  }, [
    actions.canEditExpense,
    intent.expenseId,
    intent.tripId,
    router,
  ]);

  const startContributionEdit = useCallback(
    (userId: string) => {
      if (contributionLocksRef.current.has(userId)) {
        return;
      }
      const currentParticipant = detail.participants.find(
        (participant) => participant.user_id === userId,
      );
      if (currentParticipant) {
        setDraftAmounts((current) => ({
          ...current,
          [userId]: currentParticipant.contributed_amount,
        }));
      }
      setEditingUserIds((current) => new Set(current).add(userId));
      setContributionErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setAmountErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
    },
    [detail.participants],
  );

  const changeContributionDraft = useCallback(
    (userId: string, value: string) => {
      if (contributionLocksRef.current.has(userId)) {
        return;
      }
      setDraftAmounts((current) => ({
        ...current,
        [userId]: value,
      }));
      setContributionErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setAmountErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
    },
    [],
  );

  const cancelContributionEdit = useCallback(
    (userId: string) => {
      if (contributionLocksRef.current.has(userId)) {
        return;
      }
      const currentParticipant = detail.participants.find(
        (participant) => participant.user_id === userId,
      );
      if (currentParticipant) {
        setDraftAmounts((current) => ({
          ...current,
          [userId]: currentParticipant.contributed_amount,
        }));
      }
      setEditingUserIds((current) => {
        const next = new Set(current);
        next.delete(userId);
        return next;
      });
      setContributionErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setAmountErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
    },
    [detail.participants],
  );

  const submitContribution = useCallback(
    async (userId: string) => {
      if (
        contributionLocksRef.current.has(userId) ||
        !actions.canEditContributions
      ) {
        return;
      }

      const payload = buildContributionPayload(
        draftAmounts[userId] ?? '',
        detail.currency_code,
      );
      if (!payload) {
        setAmountErrors((current) => ({
          ...current,
          [userId]: 'Enter a valid non-negative amount.',
        }));
        return;
      }

      contributionLocksRef.current.add(userId);
      setPendingUserIds((current) => new Set(current).add(userId));
      setContributionErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setAmountErrors((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      invalidateDetail();

      try {
        const response = await setContribution(
          intent.tripId,
          intent.expenseId,
          userId,
          payload,
        );
        if (mountedRef.current) {
          setDraftAmounts((current) => ({
            ...current,
            [userId]: response.amount,
          }));
          setEditingUserIds((current) => {
            const next = new Set(current);
            next.delete(userId);
            return next;
          });
        }
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId: intent.tripId,
        });
      } catch (caught) {
        const nextError = normalizeApiError(caught);
        if (mountedRef.current) {
          setContributionErrors((current) => ({
            ...current,
            [userId]: nextError.message,
          }));
        }
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId: intent.tripId,
        });
      } finally {
        contributionLocksRef.current.delete(userId);
        if (mountedRef.current) {
          setPendingUserIds((current) => {
            const next = new Set(current);
            next.delete(userId);
            return next;
          });
        }
      }
    },
    [
      actions.canEditContributions,
      detail.currency_code,
      draftAmounts,
      intent.expenseId,
      intent.tripId,
      invalidateDetail,
    ],
  );

  const performDelete = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);
    invalidateDetail();

    try {
      await deleteExpense(intent.tripId, intent.expenseId);
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: intent.tripId,
      });
      if (isScreenActive()) {
        router.dismissTo(parentHref);
      }
    } catch (caught) {
      const nextError = normalizeApiError(caught);
      if (nextError.errorCode === 'EXPENSE_NOT_FOUND') {
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId: intent.tripId,
        });
        if (isScreenActive()) {
          router.dismissTo(parentHref);
        }
      } else {
        if (mountedRef.current) {
          setDeleteError(nextError);
        }
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId: intent.tripId,
        });
      }
    } finally {
      deleteAlertLockRef.current = false;
      if (mountedRef.current) {
        setDeleting(false);
      }
    }
  }, [
    intent.expenseId,
    intent.tripId,
    invalidateDetail,
    isScreenActive,
    parentHref,
    router,
  ]);

  const confirmDelete = useCallback(() => {
    if (
      deleteAlertLockRef.current ||
      !actions.canEditExpense
    ) {
      return;
    }

    deleteAlertLockRef.current = true;
    let confirmed = false;
    const release = () => {
      deleteAlertLockRef.current = false;
    };
    Alert.alert(
      'Delete expense?',
      `Delete "${detail.title}" and its contribution records?`,
      [
        { text: 'Keep expense', style: 'cancel', onPress: release },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            confirmed = true;
            void performDelete();
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          if (!confirmed) {
            release();
          }
        },
      },
    );
  }, [actions.canEditExpense, detail.title, performDelete]);

  const pullToRefresh = useCallback(() => {
    void refreshAll('refresh');
  }, [refreshAll]);

  const backgroundError = deleteError ?? detailError ?? tripError;
  const tone = getExpenseStatusTone(detail.status);
  const lockedAtLabel = formatLockedAt(
    detail.locked_at,
    tripDetail.trip.timezone,
  );
  const header = (
    <View style={styles.detailHeader}>
      {backgroundError ? (
        <View accessibilityRole="alert" style={styles.inlineError}>
          <Ionicons
            name="alert-circle-outline"
            size={20}
            color={colors.danger}
          />
          <Text style={styles.inlineErrorText}>
            {backgroundError.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry refreshing expense detail"
            hitSlop={spacing.sm}
            onPress={() => void requestReconcile()}
            style={({ pressed }) => [
              styles.retry,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.summaryCard}>
        <View style={styles.summaryHeading}>
          <View style={styles.summaryTitleBlock}>
            <Text accessibilityRole="header" style={styles.title}>
              {detail.title}
            </Text>
            {detail.description ? (
              <Text style={styles.description}>
                {detail.description}
              </Text>
            ) : null}
          </View>
          <View
            style={[
              styles.statusBadge,
              tone === 'success'
                ? styles.successBadge
                : tone === 'danger'
                  ? styles.dangerBadge
                  : styles.warningBadge,
            ]}
          >
            <Text
              style={[
                styles.statusText,
                tone === 'success'
                  ? styles.successText
                  : tone === 'danger'
                    ? styles.dangerText
                    : styles.warningText,
              ]}
            >
              {getExpenseStatusLabel(detail.status)}
            </Text>
          </View>
        </View>
        <View style={styles.metrics}>
          <DetailMetric
            label="Total"
            value={formatExpenseMoney(
              detail.total_amount,
              detail.currency_code,
            )}
          />
          <DetailMetric
            label="Collected"
            value={formatExpenseMoney(
              detail.paid_amount,
              detail.currency_code,
            )}
            tone="success"
          />
          <DetailMetric
            label="Missing"
            value={formatExpenseMoney(
              detail.missing_amount,
              detail.currency_code,
            )}
            tone="warning"
          />
          <DetailMetric
            label="Surplus"
            value={formatExpenseMoney(
              detail.surplus_amount,
              detail.currency_code,
            )}
            tone="danger"
          />
        </View>
        <View style={styles.collectorRow}>
          <Ionicons
            name="wallet-outline"
            size={18}
            color={colors.textMuted}
          />
          <View style={styles.collectorCopy}>
            <Text style={styles.metricLabel}>Collector</Text>
            <Text style={styles.collectorName}>
              {detail.collector.display_name}
            </Text>
            {detail.collector.identify_tag ? (
              <Text style={styles.collectorTag}>
                {detail.collector.identify_tag}
              </Text>
            ) : null}
          </View>
          {detail.locked ? (
            <View style={styles.lockedBadge}>
              <Ionicons
                name="lock-closed-outline"
                size={15}
                color={colors.textMuted}
              />
              <Text style={styles.lockedText}>Locked</Text>
            </View>
          ) : null}
        </View>
      </View>
      {detail.locked ? (
        <View style={styles.lockedNotice}>
          <Text style={styles.lockedNoticeText}>
            Settlement is finalized
            {lockedAtLabel ? ` (locked on ${lockedAtLabel})` : ''}.
            Reopen it before editing expenses or contributions.
          </Text>
        </View>
      ) : null}
      {actions.canEditExpense ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete expense"
          accessibilityState={{ disabled: deleting }}
          disabled={deleting}
          onPress={confirmDelete}
          style={({ pressed }) => [
            styles.deleteButton,
            pressed && !deleting ? styles.pressed : null,
            deleting ? styles.disabled : null,
          ]}
        >
          <Ionicons
            name="trash-outline"
            size={18}
            color={colors.danger}
          />
          <Text style={styles.deleteText}>
            {deleting ? 'Deleting…' : 'Delete expense'}
          </Text>
        </Pressable>
      ) : null}
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Participants ({detail.participants.length})
      </Text>
    </View>
  );

  const renderParticipant = ({
    item,
  }: {
    item: ExpenseParticipant;
  }) => (
    <ContributionEditor
      participant={item}
      currencyCode={detail.currency_code}
      canEdit={actions.canEditContributions}
      isEditing={editingUserIds.has(item.user_id)}
      draftAmount={
        draftAmounts[item.user_id] ?? item.contributed_amount
      }
      loading={pendingUserIds.has(item.user_id)}
      error={contributionErrors[item.user_id] ?? null}
      amountError={amountErrors[item.user_id]}
      onStartEditing={startContributionEdit}
      onDraftChange={changeContributionDraft}
      onSubmit={(userId) => void submitContribution(userId)}
      onCancel={cancelContributionEdit}
    />
  );

  return (
    <SafeAreaView
      style={styles.safe}
      edges={['left', 'right', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: detail.title,
          headerRight: actions.canEditExpense
            ? () => (
                <HeaderEditAction
                  disabled={deleting}
                  onPress={openEditForm}
                />
              )
            : undefined,
        }}
      />
      <FlatList
        data={detail.participants}
        keyExtractor={(participant) => participant.user_id}
        renderItem={renderParticipant}
        extraData={{
          draftAmounts,
          editingUserIds,
          pendingUserIds,
          contributionErrors,
          amountErrors,
        }}
        refreshing={refreshing}
        onRefresh={pullToRefresh}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
      />
    </SafeAreaView>
  );
}

function ValidExpenseDetailScreen({
  intent,
}: {
  intent: ExpenseDetailRouteIntent;
}) {
  const {
    detail,
    status: detailStatus,
    error: detailError,
    refreshing: detailRefreshing,
    refresh: refreshDetail,
    invalidate: invalidateDetail,
  } = useExpenseDetail(intent.tripId, intent.expenseId, {
    autoReconcile: false,
  });
  const {
    detail: tripDetail,
    status: tripStatus,
    error: tripError,
    refreshing: tripRefreshing,
    refresh: refreshTrip,
  } = useTripDetail(intent.tripId, { autoReconcile: false });
  const {
    refreshAll,
    requestReconcile,
    isScreenActive,
  } = useExpenseCompositionCoordinator({
    tripId: intent.tripId,
    refreshExpense: refreshDetail,
    refreshTrip,
  });

  const missingError =
    (!detail ? detailError : null) ??
    (!tripDetail ? tripError : null);
  if (!detail || !tripDetail) {
    const loading =
      !missingError &&
      (detailStatus === 'loading' || tripStatus === 'loading');
    return (
      <>
        <Stack.Screen options={{ title: 'Expense' }} />
        {loading ? (
          <LoadingScreen />
        ) : (
          <RouteUnavailableState
            title={
              missingError?.errorCode === 'EXPENSE_NOT_FOUND'
                ? 'Expense unavailable'
                : missingError?.status === 404
                  ? 'Expenses unavailable'
                  : 'Could not load expense'
            }
            message="This expense no longer exists or is unavailable."
            error={missingError}
            onRetry={() => void requestReconcile(true)}
          />
        )}
      </>
    );
  }

  return (
    <HydratedExpenseDetail
      intent={intent}
      detail={detail}
      tripDetail={tripDetail}
      detailError={detailError}
      tripError={tripError}
      refreshing={detailRefreshing || tripRefreshing}
      refreshAll={refreshAll}
      requestReconcile={requestReconcile}
      invalidateDetail={invalidateDetail}
      isScreenActive={isScreenActive}
    />
  );
}

export function ExpenseDetailScreen() {
  const { tripId, expenseId } = useLocalSearchParams();
  const intent = parseExpenseDetailRouteIntent({
    tripId,
    expenseId,
  });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Expense unavailable"
        message="This expense link is invalid or incomplete."
      />
    );
  }

  return (
    <ValidExpenseDetailScreen
      key={`${intent.tripId}:${intent.expenseId}`}
      intent={intent}
    />
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  content: {
    flexGrow: 1,
    gap: spacing.md,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  detailHeader: {
    gap: spacing.md,
  },
  headerAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  headerActionText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.45 },
  inlineError: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  inlineErrorText: {
    ...typography.caption,
    flex: 1,
    color: colors.danger,
  },
  retry: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  retryText: {
    ...typography.label,
    color: colors.danger,
  },
  summaryCard: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  summaryHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  summaryTitleBlock: {
    minWidth: 0,
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    ...typography.heading,
    color: colors.text,
  },
  description: {
    ...typography.body,
    color: colors.textMuted,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  successBadge: { backgroundColor: colors.successSoft },
  dangerBadge: { backgroundColor: colors.dangerSoft },
  warningBadge: { backgroundColor: colors.warningSoft },
  statusText: { ...typography.label },
  successText: { color: colors.success },
  dangerText: { color: colors.danger },
  warningText: { color: colors.warning },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  metric: {
    minWidth: '40%',
    flexGrow: 1,
    gap: spacing.xs,
  },
  metricLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  metricValue: {
    ...typography.body,
    color: colors.text,
    fontWeight: '600',
  },
  collectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  collectorCopy: { minWidth: 0, flex: 1 },
  collectorName: {
    ...typography.label,
    color: colors.text,
  },
  collectorTag: {
    ...typography.caption,
    color: colors.textMuted,
  },
  lockedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
  },
  lockedText: {
    ...typography.label,
    color: colors.textMuted,
  },
  lockedNotice: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.warningSoft,
  },
  lockedNoticeText: {
    ...typography.body,
    color: colors.warning,
  },
  deleteButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  deleteText: {
    ...typography.label,
    color: colors.danger,
  },
  sectionTitle: {
    ...typography.heading,
    color: colors.text,
  },
});
