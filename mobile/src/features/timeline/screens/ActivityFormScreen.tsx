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
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTripDetail } from '@/features/trips/hooks/useTripDetail';
import {
  subscribeToTripEvents,
  type TripEvent,
} from '@/features/trips/tripEvents';
import type { TripDetailResponse } from '@/features/trips/types';
import { normalizeApiError, type ApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { createActivity, patchActivity } from '../api';
import {
  ActivityForm,
  type StructuredLocationEditorProps,
} from '../components/ActivityForm';
import { PlacePicker } from '../components/PlacePicker';
import {
  buildCreateActivityPayload,
  buildPatchActivityPayload,
  cloneActivityDraft,
  createActivityDraft,
  getSelectableCustomTypes,
  hydrateActivityDraft,
  validateActivityDraft,
  type ActivityDraftField,
  type ActivityFormDirtyFields,
  type ActivityFormDraft,
  type ActivityFormFieldErrors,
} from '../formModel';
import { useTimeline } from '../hooks/useTimeline';
import type { ActivityFormRouteIntent } from '../routeIntent';
import { parseActivityFormRouteIntent } from '../routeIntent';
import {
  publishTimelineEvent,
  subscribeToTimelineEvents,
} from '../timelineEvents';
import type {
  TimelineActivity,
  TimelineResponse,
  TimelineSection,
} from '../types';
import { RouteUnavailableState } from './RouteState';

interface ResolvedActivityTarget {
  section: TimelineSection;
  activity: TimelineActivity;
}

interface HeaderCancelActionProps {
  disabled: boolean;
  onPress: () => void;
}

type InitialFormState =
  | { kind: 'missing' }
  | {
      kind: 'ready';
      initialDraft: ActivityFormDraft;
      initialActivity?: TimelineActivity;
    };

interface HydratedActivityFormProps {
  intent: ActivityFormRouteIntent;
  timeline: TimelineResponse;
  detail: TripDetailResponse;
  timelineError: ApiError | null;
  tripError: ApiError | null;
  timelineRefreshing: boolean;
  tripRefreshing: boolean;
  currentCreateSection: TimelineSection | undefined;
  currentEditTarget: ResolvedActivityTarget | undefined;
  refreshAll: (mode: 'initial' | 'refresh' | 'silent') => Promise<void>;
  requestReconcile: (forceInitial?: boolean) => Promise<void>;
  invalidateTimeline: () => void;
  submitLockRef: { current: boolean };
  submitting: boolean;
  setSubmitting: (submitting: boolean) => void;
  isScreenActive: () => boolean;
  isActiveGeneration: (generation: number) => boolean;
  getGeneration: () => number;
  onCancel: () => void;
}

function getPlaceEditorError(
  fieldErrors: Readonly<Record<string, string>>,
): string | undefined {
  const messages = new Set<string>();
  for (const [field, message] of Object.entries(fieldErrors)) {
    if ((field === 'place' || field.startsWith('place.')) && message) {
      messages.add(message);
    }
  }
  return messages.size > 0 ? [...messages].join(' ') : undefined;
}

function renderStructuredLocationEditor({
  value,
  locationLabel,
  disabled,
  fieldErrors,
  onChange,
  onUseManual,
}: StructuredLocationEditorProps) {
  return (
    <PlacePicker
      value={{
        location_label: locationLabel,
        place: value?.place ?? null,
      }}
      disabled={disabled}
      error={getPlaceEditorError(fieldErrors)}
      onSelectLocation={(selection) =>
        onChange({
          location_label: selection.location_label,
          place: selection.place,
        })
      }
      onUseManualEntry={(manual) =>
        onUseManual(manual.location_label)
      }
      onLookupFailure={(failure) =>
        onUseManual(failure.location_label)
      }
    />
  );
}

function HeaderCancelAction({
  disabled,
  onPress,
}: HeaderCancelActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel timeline activity form"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerAction,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={styles.headerActionText}>Cancel</Text>
    </Pressable>
  );
}

function ActivityFormLoadError({
  error,
  onRetry,
}: {
  error: ApiError | null;
  onRetry: () => void;
}) {
  const notFound = error?.status === 404;
  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <View style={styles.centered}>
        <Ionicons
          name={notFound ? 'help-circle-outline' : 'cloud-offline-outline'}
          size={44}
          color={colors.textMuted}
        />
        <Text accessibilityRole="header" style={styles.stateTitle}>
          {notFound ? 'Activity form unavailable' : 'Could not load activity'}
        </Text>
        <Text style={styles.stateMessage}>
          {notFound
            ? 'This trip or activity no longer exists, or you no longer have access.'
            : error?.message ?? 'Activity information is unavailable.'}
        </Text>
        {notFound ? null : <Button title="Try again" onPress={onRetry} />}
      </View>
    </SafeAreaView>
  );
}

function HydratedActivityForm({
  intent,
  timeline,
  detail,
  timelineError,
  tripError,
  timelineRefreshing,
  tripRefreshing,
  currentCreateSection,
  currentEditTarget,
  refreshAll,
  requestReconcile,
  invalidateTimeline,
  submitLockRef,
  submitting,
  setSubmitting,
  isScreenActive,
  isActiveGeneration,
  getGeneration,
  onCancel,
}: HydratedActivityFormProps) {
  const router = useRouter();
  const [initialState] = useState<InitialFormState>(() =>
    buildInitialFormState(intent, currentCreateSection, currentEditTarget),
  );
  const [draft, setDraft] = useState<ActivityFormDraft | null>(() =>
    initialState.kind === 'ready'
      ? cloneActivityDraft(initialState.initialDraft)
      : null,
  );
  const [dirtyFields, setDirtyFields] =
    useState<ActivityFormDirtyFields>({});
  const [localFieldErrors, setLocalFieldErrors] =
    useState<ActivityFormFieldErrors>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const parentHref = `/trips/${intent.tripId}/timeline` as const;

  const terminal =
    detail.trip.status === 'COMPLETED' ||
    detail.trip.status === 'CANCELLED';
  const activeMembership = detail.my_membership.status === 'ACTIVE';
  const targetStillExists =
    intent.mode === 'create'
      ? currentCreateSection !== undefined
      : currentEditTarget !== undefined;
  const serverAllowsMutation =
    intent.mode === 'create'
      ? timeline.permissions.can_edit_timeline
      : currentEditTarget?.activity.capabilities.can_edit === true;
  const canMutate =
    activeMembership &&
    !terminal &&
    targetStillExists &&
    serverAllowsMutation;
  const canManageCustomTypes =
    activeMembership &&
    !terminal &&
    timeline.permissions.can_manage_custom_types;
  const authorityMessage = getAuthorityMessage({
    activeMembership,
    terminal,
    targetStillExists,
    serverAllowsMutation,
    mode: intent.mode,
  });
  const activeAssigneeIds = useMemo(
    () => new Set(detail.members.map((member) => member.user.id)),
    [detail.members],
  );
  const selectableCustomTypeIds = useMemo(
    () =>
      new Set(
        getSelectableCustomTypes(
          timeline.custom_types,
          initialState.kind === 'ready'
            ? initialState.initialActivity
            : undefined,
        ).map((customType) => customType.id),
      ),
    [initialState, timeline.custom_types],
  );

  const changeDraft = useCallback(
    (
      nextDraft: ActivityFormDraft,
      changedFields: readonly ActivityDraftField[],
    ) => {
      if (submitLockRef.current) {
        return;
      }
      setDraft(nextDraft);
      setDirtyFields((current) => {
        const next = { ...current };
        for (const field of changedFields) {
          next[field] = true;
        }
        return next;
      });
      setLocalFieldErrors({});
      setSubmitError(null);
    },
    [submitLockRef],
  );

  const manageCustomTypes = useCallback(() => {
    if (!submitLockRef.current && canManageCustomTypes) {
      router.push(`/trips/${intent.tripId}/timeline/custom-types`);
    }
  }, [canManageCustomTypes, intent.tripId, router, submitLockRef]);

  const submit = useCallback(async () => {
    if (
      submitLockRef.current ||
      !draft ||
      initialState.kind !== 'ready' ||
      !canMutate
    ) {
      return;
    }

    const validation = validateActivityDraft(draft, {
      activeAssigneeIds,
      selectableCustomTypeIds,
    });
    setLocalFieldErrors(validation.fieldErrors);
    setSubmitError(null);
    if (!validation.isValid) {
      return;
    }

    const createPayload =
      intent.mode === 'create'
        ? buildCreateActivityPayload(draft, {
            activeAssigneeIds,
            selectableCustomTypeIds,
          })
        : null;
    const patchPayload =
      intent.mode === 'edit'
        ? buildPatchActivityPayload(
            initialState.initialDraft,
            draft,
            dirtyFields,
            {
              activeAssigneeIds,
              selectableCustomTypeIds,
            },
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
    invalidateTimeline();

    try {
      if (intent.mode === 'create' && createPayload) {
        await createActivity(intent.tripId, intent.sectionId, createPayload);
      } else if (intent.mode === 'edit' && patchPayload) {
        await patchActivity(intent.tripId, intent.activityId, patchPayload);
      }

      await publishTimelineEvent({
        type: 'timelineChanged',
        tripId: intent.tripId,
      });

      if (isActiveGeneration(generation)) {
        router.dismissTo(parentHref);
      }
    } catch (caught) {
      if (!isActiveGeneration(generation)) {
        return;
      }
      const normalized = normalizeApiError(caught);
      setSubmitError(normalized);
      if (shouldReconcileAfterFailure(normalized)) {
        await refreshAll('silent');
      }
    } finally {
      submitLockRef.current = false;
      if (isScreenActive()) {
        setSubmitting(false);
      }
    }
  }, [
    activeAssigneeIds,
    canMutate,
    dirtyFields,
    draft,
    getGeneration,
    initialState,
    intent,
    invalidateTimeline,
    isActiveGeneration,
    isScreenActive,
    parentHref,
    refreshAll,
    router,
    selectableCustomTypeIds,
    setSubmitting,
    submitLockRef,
  ]);

  const pullToRefresh = useCallback(() => {
    void refreshAll('refresh');
  }, [refreshAll]);

  const retryBackground = useCallback(() => {
    void requestReconcile();
  }, [requestReconcile]);

  const title = intent.mode === 'create' ? 'Add Activity' : 'Edit Activity';

  if (initialState.kind === 'missing' || draft === null) {
    return (
      <>
        <Stack.Screen
          options={{
            title,
            gestureEnabled: true,
            headerLeft: () => (
              <HeaderCancelAction disabled={false} onPress={onCancel} />
            ),
          }}
        />
        <RouteUnavailableState
          title="Activity unavailable"
          message={
            intent.mode === 'create'
              ? 'The selected timeline day no longer exists.'
              : 'This activity no longer exists.'
          }
        />
      </>
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
              onPress={onCancel}
            />
          ),
        }}
      />
      <ActivityForm
        mode={intent.mode}
        draft={draft}
        initialActivity={initialState.initialActivity}
        systemTypes={timeline.system_types}
        customTypes={timeline.custom_types}
        members={detail.members}
        canManageCustomTypes={canManageCustomTypes}
        canSubmit={canMutate}
        authorityMessage={authorityMessage}
        submitting={submitting}
        refreshing={timelineRefreshing || tripRefreshing}
        localFieldErrors={localFieldErrors}
        submitError={submitError}
        backgroundError={timelineError ?? tripError}
        onDraftChange={changeDraft}
        onSubmit={() => void submit()}
        onRefresh={pullToRefresh}
        onRetryBackground={retryBackground}
        onManageCustomTypes={manageCustomTypes}
        renderStructuredLocationEditor={renderStructuredLocationEditor}
      />
    </>
  );
}

function ValidActivityFormScreen({
  intent,
}: {
  intent: ActivityFormRouteIntent;
}) {
  const router = useRouter();
  const {
    timeline,
    status: timelineStatus,
    error: timelineError,
    refreshing: timelineRefreshing,
    refresh: refreshTimeline,
    invalidate: invalidateTimeline,
  } = useTimeline(intent.tripId, {
    autoReconcile: false,
  });
  const {
    detail,
    status: tripStatus,
    error: tripError,
    refreshing: tripRefreshing,
    refresh: refreshTrip,
  } = useTripDetail(intent.tripId, {
    autoReconcile: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const hasRequestedInitialRef = useRef(false);
  const parentHref = `/trips/${intent.tripId}/timeline` as const;

  const refreshAll = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent') => {
      await Promise.all([refreshTimeline(mode), refreshTrip(mode)]);
    },
    [refreshTimeline, refreshTrip],
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
      if (!submitLockRef.current) {
        setSubmitting(false);
      }
      void requestReconcile();

      return () => {
        activeRef.current = false;
        generationRef.current += 1;
      };
    }, [requestReconcile]),
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
      if (activeRef.current) {
        void requestReconcile();
      }
    }, [requestReconcile]),
  );

  useEffect(
    () =>
      subscribeToTimelineEvents(intent.tripId, () => {
        if (!activeRef.current) {
          return;
        }
        return requestReconcile();
      }),
    [intent.tripId, requestReconcile],
  );

  useEffect(
    () =>
      subscribeToTripEvents((event) => {
        if (
          activeRef.current &&
          isEventForTrip(event, intent.tripId)
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

  const getGeneration = useCallback(() => generationRef.current, []);

  const cancel = useCallback(() => {
    if (!submitLockRef.current) {
      router.dismissTo(parentHref);
    }
  }, [parentHref, router]);

  const retryInitial = useCallback(() => {
    void requestReconcile(true);
  }, [requestReconcile]);

  const title = intent.mode === 'create' ? 'Add Activity' : 'Edit Activity';
  const currentCreateSection =
    intent.mode === 'create'
      ? timeline?.sections.find(
          (section) => section.id === intent.sectionId,
        )
      : undefined;
  const currentEditTarget =
    intent.mode === 'edit'
      ? findActivityTarget(timeline?.sections ?? [], intent.activityId)
      : undefined;

  if (!timeline || !detail) {
    const loadError = timelineError ?? tripError;
    const loading =
      !loadError &&
      (timelineStatus === 'loading' || tripStatus === 'loading');

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
        {loading ? (
          <LoadingScreen />
        ) : (
          <ActivityFormLoadError
            error={loadError}
            onRetry={retryInitial}
          />
        )}
      </>
    );
  }

  return (
    <HydratedActivityForm
      intent={intent}
      timeline={timeline}
      detail={detail}
      timelineError={timelineError}
      tripError={tripError}
      timelineRefreshing={timelineRefreshing}
      tripRefreshing={tripRefreshing}
      currentCreateSection={currentCreateSection}
      currentEditTarget={currentEditTarget}
      refreshAll={refreshAll}
      requestReconcile={requestReconcile}
      invalidateTimeline={invalidateTimeline}
      submitLockRef={submitLockRef}
      submitting={submitting}
      setSubmitting={setSubmitting}
      isScreenActive={isScreenActive}
      isActiveGeneration={isActiveGeneration}
      getGeneration={getGeneration}
      onCancel={cancel}
    />
  );
}

export function ActivityFormScreen() {
  const { tripId, mode, sectionId, activityId } =
    useLocalSearchParams();
  const intent = parseActivityFormRouteIntent({
    tripId,
    mode,
    sectionId,
    activityId,
  });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Form unavailable"
        message="This form link is invalid or incomplete."
      />
    );
  }

  return (
    <ValidActivityFormScreen
      key={activityFormIdentity(intent)}
      intent={intent}
    />
  );
}

function buildInitialFormState(
  intent: ActivityFormRouteIntent,
  createSection: TimelineSection | undefined,
  editTarget: ResolvedActivityTarget | undefined,
): InitialFormState {
  if (intent.mode === 'create') {
    if (!createSection) {
      return { kind: 'missing' };
    }
    return {
      kind: 'ready',
      initialDraft: createActivityDraft(),
    };
  }

  if (!editTarget) {
    return { kind: 'missing' };
  }
  return {
    kind: 'ready',
    initialDraft: hydrateActivityDraft(editTarget.activity),
    initialActivity: editTarget.activity,
  };
}

function findActivityTarget(
  sections: readonly TimelineSection[],
  activityId: string,
): ResolvedActivityTarget | undefined {
  for (const section of sections) {
    const activity = section.activities.find(
      (candidate) => candidate.id === activityId,
    );
    if (activity) {
      return { section, activity };
    }
  }
  return undefined;
}

function activityFormIdentity(intent: ActivityFormRouteIntent): string {
  return intent.mode === 'create'
    ? `${intent.tripId}:create:${intent.sectionId}`
    : `${intent.tripId}:edit:${intent.activityId}`;
}

function isEventForTrip(event: TripEvent, tripId: string): boolean {
  return event.type === 'updated'
    ? event.trip.id === tripId
    : event.tripId === tripId;
}

function shouldReconcileAfterFailure(error: ApiError): boolean {
  return error.status === 403 || error.status === 404 || error.status === 409;
}

function getAuthorityMessage({
  activeMembership,
  terminal,
  targetStillExists,
  serverAllowsMutation,
  mode,
}: {
  activeMembership: boolean;
  terminal: boolean;
  targetStillExists: boolean;
  serverAllowsMutation: boolean;
  mode: 'create' | 'edit';
}): string | undefined {
  if (!activeMembership) {
    return 'You are no longer an active member of this trip.';
  }
  if (terminal) {
    return 'Completed and cancelled trips can no longer be edited.';
  }
  if (!targetStillExists) {
    return mode === 'create'
      ? 'This timeline day no longer exists.'
      : 'This activity no longer exists.';
  }
  if (!serverAllowsMutation) {
    return 'You no longer have permission to save this activity.';
  }
  return undefined;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  stateTitle: {
    ...typography.heading,
    color: colors.text,
    textAlign: 'center',
  },
  stateMessage: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  headerAction: {
    minHeight: 44,
    justifyContent: 'center',
    marginLeft: -spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  headerActionText: { ...typography.body, color: colors.primary },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.55 },
});
