import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  useCallback,
  useMemo,
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
import { useSession } from '@/features/auth/session';
import { useTripDetail } from '@/features/trips/hooks/useTripDetail';
import type { ApiError } from '@/shared/api/errors';
import { normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { getExpenseDashboardActions } from '../actions';
import {
  confirmTransferReceived,
  finalizeSettlement,
  markTransferSent,
  reopenSettlement,
} from '../api';
import { ExpenseRow } from '../components/ExpenseRow';
import { ExpenseSummaryStrip } from '../components/ExpenseSummaryStrip';
import { MemberBalanceRow } from '../components/MemberBalanceRow';
import { SettlementPanel } from '../components/SettlementPanel';
import { TransferRow } from '../components/TransferRow';
import { publishExpenseEvent } from '../expenseEvents';
import { useExpenseCompositionCoordinator } from '../hooks/useExpenseCompositionCoordinator';
import { useExpenseDashboard } from '../hooks/useExpenseDashboard';
import { parseExpensesRouteIntent } from '../routeIntent';
import type { ExpenseDashboardRow } from '../viewModel';
import {
  buildExpenseDashboardRows,
  getExpenseDashboardRowKey,
} from '../viewModel';
import { RouteUnavailableState } from './RouteState';

type SettlementAction = 'finalize' | 'reopen';
type TransferAction = 'sent' | 'received';

function HeaderAddAction({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add expense"
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
      <Ionicons name="add" size={21} color={colors.primary} />
      <Text style={styles.headerActionText}>Add</Text>
    </Pressable>
  );
}

function InlineError({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry: () => void;
}) {
  return (
    <View accessibilityRole="alert" style={styles.inlineError}>
      <Ionicons
        name="alert-circle-outline"
        size={20}
        color={colors.danger}
      />
      <Text style={styles.inlineErrorText}>{error.message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry refreshing expenses"
        hitSlop={spacing.sm}
        onPress={onRetry}
        style={({ pressed }) => [
          styles.retry,
          pressed ? styles.pressed : null,
        ]}
      >
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  );
}

function ValidExpensesScreen({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { user } = useSession();
  const {
    dashboard,
    status: dashboardStatus,
    error: dashboardError,
    refreshing: dashboardRefreshing,
    refresh: refreshDashboard,
    invalidate: invalidateDashboard,
  } = useExpenseDashboard(tripId, { autoReconcile: false });
  const {
    detail: tripDetail,
    status: tripStatus,
    error: tripError,
    refreshing: tripRefreshing,
    refresh: refreshTrip,
  } = useTripDetail(tripId, { autoReconcile: false });
  const {
    refreshAll,
    requestReconcile,
  } = useExpenseCompositionCoordinator({
    tripId,
    refreshExpense: refreshDashboard,
    refreshTrip,
  });
  const settlementAlertLockRef = useRef(false);
  const transferLocksRef = useRef(new Set<string>());
  const [pendingSettlementAction, setPendingSettlementAction] =
    useState<SettlementAction | null>(null);
  const [settlementError, setSettlementError] =
    useState<ApiError | null>(null);
  const [pendingTransferIds, setPendingTransferIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [transferErrors, setTransferErrors] = useState<
    Record<string, ApiError>
  >({});

  const rows = useMemo(
    () =>
      dashboard && tripDetail
        ? buildExpenseDashboardRows(dashboard, tripDetail.members)
        : [],
    [dashboard, tripDetail],
  );

  const actions = useMemo(() => {
    if (!dashboard || !tripDetail) {
      return {
        canAddExpense: false,
        canFinalize: false,
        canReopen: false,
      };
    }

    return getExpenseDashboardActions({
      canManageExpenses:
        tripDetail.my_membership.status === 'ACTIVE' &&
        dashboard.permissions.can_manage_expenses,
      tripStatus: tripDetail.trip.status,
      settlement: dashboard.settlement,
      expenseCount: dashboard.expenses.length,
    });
  }, [dashboard, tripDetail]);

  const openCreateForm = useCallback(() => {
    if (actions.canAddExpense) {
      router.push(`/trips/${tripId}/expenses/expense-form?mode=create`);
    }
  }, [actions.canAddExpense, router, tripId]);

  const openExpense = useCallback(
    (expenseId: string) => {
      router.push(`/trips/${tripId}/expenses/${expenseId}`);
    },
    [router, tripId],
  );

  const performSettlementAction = useCallback(
    async (action: SettlementAction) => {
      setPendingSettlementAction(action);
      setSettlementError(null);
      invalidateDashboard();

      try {
        if (action === 'finalize') {
          await finalizeSettlement(tripId);
        } else {
          await reopenSettlement(tripId);
        }
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId,
        });
      } catch (caught) {
        setSettlementError(normalizeApiError(caught));
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId,
        });
      } finally {
        settlementAlertLockRef.current = false;
        setPendingSettlementAction(null);
      }
    },
    [invalidateDashboard, tripId],
  );

  const confirmFinalize = useCallback(() => {
    if (
      settlementAlertLockRef.current ||
      !actions.canFinalize
    ) {
      return;
    }

    settlementAlertLockRef.current = true;
    let confirmed = false;
    const release = () => {
      settlementAlertLockRef.current = false;
    };
    Alert.alert(
      'Finalize settlement?',
      'All expenses will be locked and the transfer list will be created.',
      [
        { text: 'Cancel', style: 'cancel', onPress: release },
        {
          text: 'Finalize',
          onPress: () => {
            confirmed = true;
            void performSettlementAction('finalize');
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
  }, [actions.canFinalize, performSettlementAction]);

  const performReopen = useCallback(() => {
    if (
      settlementAlertLockRef.current ||
      !actions.canReopen
    ) {
      return;
    }
    settlementAlertLockRef.current = true;
    void performSettlementAction('reopen');
  }, [actions.canReopen, performSettlementAction]);

  const performTransferAction = useCallback(
    async (transferId: string, action: TransferAction) => {
      if (transferLocksRef.current.has(transferId)) {
        return;
      }

      transferLocksRef.current.add(transferId);
      setPendingTransferIds(
        (current) => new Set(current).add(transferId),
      );
      setTransferErrors((current) => {
        const next = { ...current };
        delete next[transferId];
        return next;
      });
      invalidateDashboard();

      try {
        if (action === 'sent') {
          await markTransferSent(tripId, transferId);
        } else {
          await confirmTransferReceived(tripId, transferId);
        }
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId,
        });
      } catch (caught) {
        const nextError = normalizeApiError(caught);
        setTransferErrors((current) => ({
          ...current,
          [transferId]: nextError,
        }));
        await publishExpenseEvent({
          type: 'expensesChanged',
          tripId,
        });
      } finally {
        transferLocksRef.current.delete(transferId);
        setPendingTransferIds((current) => {
          const next = new Set(current);
          next.delete(transferId);
          return next;
        });
      }
    },
    [invalidateDashboard, tripId],
  );

  const markSent = useCallback(
    (transferId: string) => {
      void performTransferAction(transferId, 'sent');
    },
    [performTransferAction],
  );

  const confirmReceived = useCallback(
    (transferId: string) => {
      void performTransferAction(transferId, 'received');
    },
    [performTransferAction],
  );

  const retry = useCallback(() => {
    void requestReconcile(true);
  }, [requestReconcile]);

  const pullToRefresh = useCallback(() => {
    void refreshAll('refresh');
  }, [refreshAll]);

  const missingError =
    (!dashboard ? dashboardError : null) ??
    (!tripDetail ? tripError : null);
  if (!dashboard || !tripDetail) {
    const loading =
      !missingError &&
      (dashboardStatus === 'loading' || tripStatus === 'loading');
    return (
      <>
        <Stack.Screen options={{ title: 'Expenses' }} />
        {loading ? (
          <LoadingScreen />
        ) : (
          <RouteUnavailableState
            title={
              missingError?.status === 404
                ? 'Expenses unavailable'
                : 'Could not load expenses'
            }
            message="This trip does not exist or you are not a member of it."
            error={missingError}
            onRetry={retry}
          />
        )}
      </>
    );
  }

  const backgroundError =
    settlementError ?? dashboardError ?? tripError;
  const firstTransferIndex = rows.findIndex(
    (row) => row.type === 'transfer',
  );
  const firstBalanceIndex = rows.findIndex(
    (row) => row.type === 'member-balance',
  );
  const firstExpenseIndex = rows.findIndex(
    (row) => row.type === 'expense' || row.type === 'empty',
  );

  const renderRow = ({
    item,
    index,
  }: {
    item: ExpenseDashboardRow;
    index: number;
  }) => {
    const sectionTitle =
      index === firstTransferIndex
        ? 'Transfers'
        : index === firstBalanceIndex
          ? 'Member balances'
          : index === firstExpenseIndex
            ? 'Expenses'
            : null;

    return (
      <View style={styles.rowWrap}>
        {sectionTitle ? (
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {sectionTitle}
          </Text>
        ) : null}
        {item.type === 'transfer' ? (
          <TransferRow
            transfer={item.transfer}
            currencyCode={dashboard.currency_code}
            viewerId={user?.id ?? null}
            loading={pendingTransferIds.has(item.transfer.id)}
            error={transferErrors[item.transfer.id] ?? null}
            onMarkSent={markSent}
            onConfirmReceived={confirmReceived}
          />
        ) : item.type === 'member-balance' ? (
          <MemberBalanceRow
            memberName={item.displayName}
            identifyTag={item.identifyTag}
            balance={item.balance}
            currencyCode={dashboard.currency_code}
          />
        ) : item.type === 'expense' ? (
          <ExpenseRow
            expense={item.expense}
            onPress={openExpense}
          />
        ) : (
          <View style={styles.emptyCard}>
            <Ionicons
              name="receipt-outline"
              size={30}
              color={colors.textMuted}
            />
            <Text style={styles.emptyTitle}>No expenses yet</Text>
            <Text style={styles.emptyText}>
              Add the first shared cost to start tracking contributions.
            </Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView
      style={styles.safe}
      edges={['left', 'right', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: 'Expenses',
          headerRight: actions.canAddExpense
            ? () => (
                <HeaderAddAction
                  disabled={pendingSettlementAction !== null}
                  onPress={openCreateForm}
                />
              )
            : undefined,
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={getExpenseDashboardRowKey}
        renderItem={renderRow}
        extraData={{
          pendingTransferIds,
          transferErrors,
        }}
        refreshing={dashboardRefreshing || tripRefreshing}
        onRefresh={pullToRefresh}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {backgroundError ? (
              <InlineError
                error={backgroundError}
                onRetry={() => void requestReconcile()}
              />
            ) : null}
            <ExpenseSummaryStrip
              summary={dashboard.summary}
              myBalance={dashboard.my_balance}
              currencyCode={dashboard.currency_code}
            />
            {dashboard.settlement ? (
              <SettlementPanel
                settlement={dashboard.settlement}
                canReopen={actions.canReopen}
                reopening={pendingSettlementAction === 'reopen'}
                error={
                  pendingSettlementAction === 'reopen'
                    ? settlementError
                    : null
                }
                onReopen={performReopen}
              />
            ) : actions.canFinalize ? (
              <Button
                title="Finalize settlement"
                loading={pendingSettlementAction === 'finalize'}
                onPress={confirmFinalize}
              />
            ) : null}
          </View>
        }
      />
    </SafeAreaView>
  );
}

export function ExpensesScreen() {
  const { tripId } = useLocalSearchParams();
  const intent = parseExpensesRouteIntent({ tripId });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Expenses unavailable"
        message="This expenses link is invalid or incomplete."
      />
    );
  }

  return (
    <ValidExpensesScreen key={intent.tripId} tripId={intent.tripId} />
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
  header: {
    gap: spacing.md,
  },
  headerAction: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
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
  rowWrap: {
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.heading,
    color: colors.text,
  },
  emptyCard: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  emptyTitle: {
    ...typography.heading,
    color: colors.text,
    textAlign: 'center',
  },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
