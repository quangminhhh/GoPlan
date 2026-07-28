import { Ionicons } from '@expo/vector-icons';
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTripDetail } from '@/features/trips/hooks/useTripDetail';
import {
  subscribeToTripEvents,
  type TripEvent,
} from '@/features/trips/tripEvents';
import type { ApiError } from '@/shared/api/errors';
import { normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import {
  getExpenseDashboardActions,
  getExpenseItemActions,
} from '../actions';
import {
  createExpense,
  updateExpense,
} from '../api';
import { ExpenseForm } from '../components/ExpenseForm';
import {
  publishExpenseEvent,
  subscribeToExpenseEvents,
} from '../expenseEvents';
import {
  buildCreateExpensePayload,
  buildPatchExpensePayload,
  cloneExpenseDraft,
  createExpenseDraft,
  getDepartedCurrentCollector,
  getEligibleCollectors,
  getExpenseDirtyFields,
  hydrateExpenseDraft,
  validateExpenseDraft,
  type ExpenseDraftField,
  type ExpenseFormDirtyFields,
  type ExpenseFormDraft,
  type ExpenseFormFieldErrors,
} from '../formModel';
import { useExpenseDashboard } from '../hooks/useExpenseDashboard';
import { useExpenseDetail } from '../hooks/useExpenseDetail';
import {
  parseExpenseFormRouteIntent,
  type ExpenseFormRouteIntent,
} from '../routeIntent';
import type {
  ExpenseDashboardResponse,
  ExpenseDetailResponse,
} from '../types';
import { RouteUnavailableState } from './RouteState';

interface HeaderCancelActionProps {
  disabled: boolean;
  onPress: () => void;
}

function HeaderCancelAction({
  disabled,
  onPress,
}: HeaderCancelActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel expense form"
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
      <Ionicons
        name="close"
        size={20}
        color={disabled ? colors.textMuted : colors.primary}
      />
      <Text
        style={[
          styles.headerActionText,
          disabled ? styles.headerActionTextDisabled : null,
        ]}
      >
        Cancel
      </Text>
    </Pressable>
  );
}

function isTripEventForTrip(event: TripEvent, tripId: string): boolean {
  return event.type === 'updated'
    ? event.trip.id === tripId
    : event.tripId === tripId;
}

function shouldReconcileAfterFailure(error: ApiError): boolean {
  return (
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409
  );
}

interface HydratedExpenseFormProps {
  intent: ExpenseFormRouteIntent;
  tripDetail: NonNullable<
    ReturnType<typeof useTripDetail>['detail']
  >;
  dashboard: ExpenseDashboardResponse | null;
  expenseDetail: ExpenseDetailResponse | null;
  sourceError: ApiError | null;
  tripError: ApiError | null;
  refreshing: boolean;
  refreshAll: (
    mode: 'initial' | 'refresh' | 'silent',
  ) => Promise<void>;
  requestReconcile: (forceInitial?: boolean) => Promise<void>;
  invalidateExpense: () => void;
  submitLockRef: { current: boolean };
  submissionCommittedRef: { current: boolean };
  submitting: boolean;
  setSubmitting: (submitting: boolean) => void;
  isScreenActive: () => boolean;
  isActiveGeneration: (generation: number) => boolean;
  getGeneration: () => number;
}

interface ImmutableFormState {
  initialDraft: ExpenseFormDraft;
  participants: ExpenseDetailResponse['participants'] | null;
  currentCollector: ExpenseDetailResponse['collector'] | null;
}

function buildImmutableFormState({
  intent,
  expenseDetail,
}: Pick<
  HydratedExpenseFormProps,
  'intent' | 'expenseDetail'
>): ImmutableFormState {
  if (intent.mode === 'edit' && expenseDetail) {
    return {
      initialDraft: hydrateExpenseDraft(expenseDetail),
      participants: [...expenseDetail.participants],
      currentCollector: expenseDetail.collector,
    };
  }

  return {
    initialDraft: createExpenseDraft(),
    participants: null,
    currentCollector: null,
  };
}

function getAuthorityMessage({
  intent,
  activeMembership,
  terminal,
  serverAllowsMutation,
  locked,
  currencyMatches,
}: {
  intent: ExpenseFormRouteIntent;
  activeMembership: boolean;
  terminal: boolean;
  serverAllowsMutation: boolean;
  locked: boolean;
  currencyMatches: boolean;
}): string | undefined {
  if (!activeMembership) {
    return 'You are no longer an active member of this trip.';
  }
  if (terminal) {
    return 'Completed or cancelled trips cannot change expenses.';
  }
  if (locked) {
    return 'Settlement is finalized. Reopen it before editing expenses.';
  }
  if (!currencyMatches) {
    return 'Expense currency changed. Refresh before continuing.';
  }
  if (!serverAllowsMutation) {
    return intent.mode === 'create'
      ? 'Only the trip captain can add expenses.'
      : 'You can no longer edit this expense.';
  }
  return undefined;
}

function HydratedExpenseForm({
  intent,
  tripDetail,
  dashboard,
  expenseDetail,
  sourceError,
  tripError,
  refreshing,
  refreshAll,
  requestReconcile,
  invalidateExpense,
  submitLockRef,
  submissionCommittedRef,
  submitting,
  setSubmitting,
  isScreenActive,
  isActiveGeneration,
  getGeneration,
}: HydratedExpenseFormProps) {
  const router = useRouter();
  const [immutable] = useState<ImmutableFormState>(() =>
    buildImmutableFormState({ intent, expenseDetail }),
  );
  const [draft, setDraft] = useState<ExpenseFormDraft>(() =>
    cloneExpenseDraft(immutable.initialDraft),
  );
  const [fieldErrors, setFieldErrors] =
    useState<ExpenseFormFieldErrors>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(
    null,
  );
  const dirtyFields = useMemo<ExpenseFormDirtyFields>(
    () => getExpenseDirtyFields(immutable.initialDraft, draft),
    [draft, immutable.initialDraft],
  );
  const dirty = Object.keys(dirtyFields).length > 0;
  const collectors = useMemo(
    () =>
      getEligibleCollectors(
        tripDetail.members,
        immutable.participants ?? undefined,
      ),
    [immutable.participants, tripDetail.members],
  );
  const eligibleCollectorIds = useMemo(
    () => new Set(collectors.map((member) => member.user.id)),
    [collectors],
  );
  const currentCollector = immutable.currentCollector;
  const departedCurrentCollector = currentCollector
    ? getDepartedCurrentCollector(currentCollector, collectors)
    : null;
  const activeMembership =
    tripDetail.my_membership.status === 'ACTIVE';
  const terminal =
    tripDetail.trip.status === 'COMPLETED' ||
    tripDetail.trip.status === 'CANCELLED';
  const currencyCode = tripDetail.trip.currency_code;
  const currencyMatches =
    intent.mode === 'create'
      ? dashboard?.currency_code === currencyCode
      : expenseDetail?.currency_code === currencyCode;
  const dashboardActions =
    intent.mode === 'create' && dashboard
      ? getExpenseDashboardActions({
          canManageExpenses:
            activeMembership &&
            dashboard.permissions.can_manage_expenses,
          tripStatus: tripDetail.trip.status,
          settlement: dashboard.settlement,
          expenseCount: dashboard.expenses.length,
        })
      : null;
  const itemActions =
    intent.mode === 'edit' && expenseDetail
      ? getExpenseItemActions({
          canManageExpenses:
            activeMembership &&
            expenseDetail.permissions.can_manage_expenses,
          tripStatus: tripDetail.trip.status,
          locked: expenseDetail.locked,
        })
      : null;
  const locked = expenseDetail?.locked ?? false;
  const serverAllowsMutation =
    intent.mode === 'create'
      ? dashboardActions?.canAddExpense === true
      : itemActions?.canEditExpense === true;
  const canSubmit =
    activeMembership &&
    !terminal &&
    currencyMatches &&
    serverAllowsMutation;
  const authorityMessage = getAuthorityMessage({
    intent,
    activeMembership,
    terminal,
    serverAllowsMutation,
    locked,
    currencyMatches,
  });
  const parentHref =
    intent.mode === 'create'
      ? (`/trips/${intent.tripId}/expenses` as const)
      : (`/trips/${intent.tripId}/expenses/${intent.expenseId}` as const);

  const changeDraft = useCallback(
    (changes: Partial<ExpenseFormDraft>) => {
      if (submitLockRef.current) {
        return;
      }
      setDraft((current) => ({ ...current, ...changes }));
      const changedFields = Object.keys(changes) as ExpenseDraftField[];
      setFieldErrors((current) => {
        const next = { ...current };
        for (const field of changedFields) {
          delete next[field];
        }
        return next;
      });
      setSubmitError(null);
    },
    [submitLockRef],
  );

  const submit = useCallback(async () => {
    if (submitLockRef.current || !canSubmit) {
      return;
    }

    const validation = validateExpenseDraft(
      draft,
      currencyCode,
      {
        mode: intent.mode,
        eligibleCollectorIds,
        initialCollectorId:
          immutable.initialDraft.collector_id,
      },
    );
    setFieldErrors(validation.fieldErrors);
    setSubmitError(null);
    if (!validation.isValid) {
      return;
    }

    const createPayload =
      intent.mode === 'create'
        ? buildCreateExpensePayload(
            draft,
            currencyCode,
            eligibleCollectorIds,
          )
        : null;
    const patchPayload =
      intent.mode === 'edit'
        ? buildPatchExpensePayload(
            immutable.initialDraft,
            draft,
            currencyCode,
            dirtyFields,
            eligibleCollectorIds,
          )
        : null;

    if (intent.mode === 'create' && !createPayload) {
      return;
    }
    if (intent.mode === 'edit' && !patchPayload) {
      return;
    }
    if (
      intent.mode === 'edit' &&
      patchPayload &&
      Object.keys(patchPayload).length === 0
    ) {
      if (isActiveGeneration(getGeneration())) {
        router.dismissTo(parentHref);
      }
      return;
    }

    const generation = getGeneration();
    submitLockRef.current = true;
    setSubmitting(true);
    invalidateExpense();

    try {
      if (intent.mode === 'create' && createPayload) {
        await createExpense(intent.tripId, createPayload);
      } else if (intent.mode === 'edit' && patchPayload) {
        await updateExpense(
          intent.tripId,
          intent.expenseId,
          patchPayload,
        );
      }
      submissionCommittedRef.current = true;
      await publishExpenseEvent({
        type: 'expensesChanged',
        tripId: intent.tripId,
      });
      if (isScreenActive()) {
        router.dismissTo(parentHref);
      }
    } catch (caught) {
      if (submissionCommittedRef.current) {
        if (isScreenActive()) {
          router.dismissTo(parentHref);
        }
        return;
      }
      if (!isActiveGeneration(generation)) {
        return;
      }

      const nextError = normalizeApiError(caught);
      setSubmitError(nextError);
      if (shouldReconcileAfterFailure(nextError)) {
        await refreshAll('silent');
      }
    } finally {
      if (!submissionCommittedRef.current) {
        submitLockRef.current = false;
      }
      if (!submissionCommittedRef.current && isScreenActive()) {
        setSubmitting(false);
      }
    }
  }, [
    canSubmit,
    currencyCode,
    dirtyFields,
    draft,
    eligibleCollectorIds,
    getGeneration,
    immutable.initialDraft,
    intent,
    invalidateExpense,
    isActiveGeneration,
    isScreenActive,
    parentHref,
    refreshAll,
    router,
    setSubmitting,
    submissionCommittedRef,
    submitLockRef,
  ]);

  return (
    <ExpenseForm
      mode={intent.mode}
      draft={draft}
      fieldErrors={fieldErrors}
      submitError={submitError}
      collectors={collectors}
      currentCollector={departedCurrentCollector}
      currencyCode={currencyCode}
      canSubmit={canSubmit}
      dirty={dirty}
      submitting={submitting}
      refreshing={refreshing}
      authorityMessage={authorityMessage}
      backgroundError={sourceError ?? tripError}
      onChange={changeDraft}
      onSubmit={() => void submit()}
      onRefresh={() => void refreshAll('refresh')}
      onRetryBackground={() => void requestReconcile()}
    />
  );
}

function ValidExpenseFormScreen({
  intent,
}: {
  intent: ExpenseFormRouteIntent;
}) {
  const router = useRouter();
  const dashboardHook = useExpenseDashboard(
    intent.mode === 'create' ? intent.tripId : undefined,
    { autoReconcile: false },
  );
  const detailHook = useExpenseDetail(
    intent.mode === 'edit' ? intent.tripId : undefined,
    intent.mode === 'edit' ? intent.expenseId : undefined,
    { autoReconcile: false },
  );
  const {
    detail: tripDetail,
    error: tripError,
    status: tripStatus,
    refreshing: tripRefreshing,
    refresh: refreshTrip,
  } = useTripDetail(intent.tripId, {
    autoReconcile: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const submissionCommittedRef = useRef(false);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const hasRequestedInitialRef = useRef(false);
  const parentHref =
    intent.mode === 'create'
      ? (`/trips/${intent.tripId}/expenses` as const)
      : (`/trips/${intent.tripId}/expenses/${intent.expenseId}` as const);
  const refreshExpense =
    intent.mode === 'create'
      ? dashboardHook.refresh
      : detailHook.refresh;
  const invalidateExpense =
    intent.mode === 'create'
      ? dashboardHook.invalidate
      : detailHook.invalidate;

  const refreshAll = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent') => {
      await Promise.all([
        refreshExpense(mode),
        refreshTrip(mode),
      ]);
    },
    [refreshExpense, refreshTrip],
  );

  const requestReconcile = useCallback(
    (forceInitial = false) => {
      const mode =
        forceInitial || !hasRequestedInitialRef.current
          ? 'initial'
          : 'silent';
      hasRequestedInitialRef.current = true;
      return refreshAll(mode);
    },
    [refreshAll],
  );

  useFocusEffect(
    useCallback(() => {
      activeRef.current = true;
      generationRef.current += 1;
      if (submissionCommittedRef.current) {
        router.dismissTo(parentHref);
      } else {
        if (!submitLockRef.current) {
          setSubmitting(false);
        }
        void requestReconcile();
      }

      return () => {
        activeRef.current = false;
        generationRef.current += 1;
      };
    }, [parentHref, requestReconcile, router]),
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      activeRef.current = false;
      generationRef.current += 1;
    },
    [],
  );

  useAppForegroundEffect(
    useCallback(() => {
      if (
        activeRef.current &&
        !submissionCommittedRef.current
      ) {
        void requestReconcile();
      }
    }, [requestReconcile]),
  );

  useEffect(
    () =>
      subscribeToExpenseEvents(intent.tripId, () => {
        if (
          activeRef.current &&
          !submissionCommittedRef.current
        ) {
          return requestReconcile();
        }
        return undefined;
      }),
    [intent.tripId, requestReconcile],
  );

  useEffect(
    () =>
      subscribeToTripEvents((event) => {
        if (
          activeRef.current &&
          !submissionCommittedRef.current &&
          isTripEventForTrip(event, intent.tripId)
        ) {
          void requestReconcile();
        }
      }),
    [intent.tripId, requestReconcile],
  );

  const isActiveGeneration = useCallback((generation: number) => {
    return (
      mountedRef.current &&
      activeRef.current &&
      generationRef.current === generation
    );
  }, []);
  const isScreenActive = useCallback(
    () => mountedRef.current && activeRef.current,
    [],
  );
  const getGeneration = useCallback(
    () => generationRef.current,
    [],
  );
  const cancel = useCallback(() => {
    if (!submitLockRef.current) {
      router.dismissTo(parentHref);
    }
  }, [parentHref, router]);

  const dashboard =
    intent.mode === 'create' ? dashboardHook.dashboard : null;
  const expenseDetail =
    intent.mode === 'edit' ? detailHook.detail : null;
  const sourceStatus =
    intent.mode === 'create'
      ? dashboardHook.status
      : detailHook.status;
  const sourceError =
    intent.mode === 'create'
      ? dashboardHook.error
      : detailHook.error;
  const sourceRefreshing =
    intent.mode === 'create'
      ? dashboardHook.refreshing
      : detailHook.refreshing;
  const sourceReady =
    intent.mode === 'create'
      ? dashboard !== null
      : expenseDetail !== null;
  const missingError =
    (!sourceReady ? sourceError : null) ??
    (!tripDetail ? tripError : null);
  const title =
    intent.mode === 'create' ? 'Add Expense' : 'Edit Expense';

  let content;
  if (!sourceReady || !tripDetail) {
    const loading =
      !missingError &&
      (sourceStatus === 'loading' ||
        tripStatus === 'loading');
    content = loading ? (
      <LoadingScreen />
    ) : (
      <RouteUnavailableState
        title={
          missingError?.errorCode === 'EXPENSE_NOT_FOUND'
            ? 'Expense unavailable'
            : missingError?.status === 404
              ? 'Expenses unavailable'
              : 'Could not load expense form'
        }
        message="This form is no longer available."
        error={missingError}
        onRetry={() => void requestReconcile(true)}
      />
    );
  } else {
    content = (
      <HydratedExpenseForm
        intent={intent}
        tripDetail={tripDetail}
        dashboard={dashboard}
        expenseDetail={expenseDetail}
        sourceError={sourceError}
        tripError={tripError}
        refreshing={sourceRefreshing || tripRefreshing}
        refreshAll={refreshAll}
        requestReconcile={requestReconcile}
        invalidateExpense={invalidateExpense}
        submitLockRef={submitLockRef}
        submissionCommittedRef={submissionCommittedRef}
        submitting={submitting}
        setSubmitting={setSubmitting}
        isScreenActive={isScreenActive}
        isActiveGeneration={isActiveGeneration}
        getGeneration={getGeneration}
      />
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title,
          gestureEnabled: !submitting,
          headerLeft: () => (
            <HeaderCancelAction
              disabled={submitting}
              onPress={cancel}
            />
          ),
        }}
      />
      {content}
    </>
  );
}

export function ExpenseFormScreen() {
  const { tripId, mode, expenseId } = useLocalSearchParams();
  const intent = parseExpenseFormRouteIntent({
    tripId,
    mode,
    expenseId,
  });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Form unavailable"
        message="This form link is invalid or incomplete."
      />
    );
  }

  const identity =
    intent.mode === 'create'
      ? `${intent.tripId}:create`
      : `${intent.tripId}:edit:${intent.expenseId}`;
  return (
    <ValidExpenseFormScreen
      key={identity}
      intent={intent}
    />
  );
}

const styles = StyleSheet.create({
  headerAction: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginLeft: -spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  headerActionText: {
    ...typography.body,
    color: colors.primary,
  },
  headerActionTextDisabled: {
    color: colors.textMuted,
  },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.55 },
});
