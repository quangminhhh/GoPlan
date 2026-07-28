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
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { createSection, patchSection } from '../api';
import { SectionForm } from '../components/SectionForm';
import {
  buildCreateSectionPayload,
  buildPatchSectionPayload,
  createSectionDraft,
  getSectionDirtyFields,
  hydrateSectionDraft,
  type SectionFormDraft,
  type SectionFormFieldErrors,
  validateSectionDraft,
} from '../formModel';
import {
  type TimelineLoadMode,
  useTimeline,
} from '../hooks/useTimeline';
import type { SectionFormRouteIntent } from '../routeIntent';
import { parseSectionFormRouteIntent } from '../routeIntent';
import {
  publishTimelineEvent,
  subscribeToTimelineEvents,
} from '../timelineEvents';
import type { TimelineResponse } from '../types';
import { getTodayDateInTimeZone } from '../viewModel';
import { RouteUnavailableState } from './RouteState';

interface SectionFormStateProps {
  title: string;
  message: string;
  actionTitle?: string;
  onAction?: () => void;
}

function SectionFormState({
  title,
  message,
  actionTitle,
  onAction,
}: SectionFormStateProps) {
  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <View style={styles.centered}>
        <Ionicons
          name="calendar-outline"
          size={44}
          color={colors.textMuted}
        />
        <Text accessibilityRole="header" style={styles.stateTitle}>
          {title}
        </Text>
        <Text style={styles.stateBody}>{message}</Text>
        {actionTitle && onAction ? (
          <Button title={actionTitle} onPress={onAction} />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function HeaderCancelAction({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Cancel timeline day form"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={spacing.sm}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerAction,
        (pressed || disabled) && styles.headerActionMuted,
      ]}
    >
      <Text style={styles.headerActionText}>Cancel</Text>
    </Pressable>
  );
}

function hasDirtyFields(
  initial: SectionFormDraft,
  draft: SectionFormDraft,
): boolean {
  return Object.values(getSectionDirtyFields(initial, draft)).some(Boolean);
}

function isUnavailableDate(
  sections: readonly { id: string; section_date: string }[],
  sectionDate: string,
  editedSectionId?: string,
): boolean {
  return sections.some(
    (section) =>
      section.id !== editedSectionId &&
      section.section_date === sectionDate,
  );
}

function shouldReconcileAfterFailure(error: ApiError): boolean {
  return error.status === 403 || error.status === 404 || error.status === 409;
}

interface SectionFormEditorProps {
  intent: SectionFormRouteIntent;
  timeline: TimelineResponse;
  initialDraft: SectionFormDraft;
  canManage: boolean;
  submitLockRef: { current: boolean };
  submissionCommittedRef: { current: boolean };
  submitting: boolean;
  setSubmitting: (submitting: boolean) => void;
  invalidate: () => void;
  refresh: (mode?: TimelineLoadMode) => Promise<void>;
  getGeneration: () => number;
  isScreenActive: () => boolean;
  isActiveGeneration: (generation: number) => boolean;
  onCancel: () => void;
  onConfirmedSuccess: () => void;
}

function SectionFormEditor({
  intent,
  timeline,
  initialDraft,
  canManage,
  submitLockRef,
  submissionCommittedRef,
  submitting,
  setSubmitting,
  invalidate,
  refresh,
  getGeneration,
  isScreenActive,
  isActiveGeneration,
  onCancel,
  onConfirmedSuccess,
}: SectionFormEditorProps) {
  const [initial] = useState<SectionFormDraft>(() => ({
    ...initialDraft,
  }));
  const [draft, setDraft] = useState<SectionFormDraft>(() => ({
    ...initialDraft,
  }));
  const [fieldErrors, setFieldErrors] =
    useState<SectionFormFieldErrors>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const mountedRef = useRef(true);
  const editedSectionId =
    intent.mode === 'edit' ? intent.sectionId : undefined;
  const dateUnavailable = isUnavailableDate(
    timeline.sections,
    draft.section_date,
    editedSectionId,
  );
  const dirty = hasDirtyFields(initial, draft);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const changeDraft = useCallback(
    (changes: Partial<SectionFormDraft>) => {
      if (submitLockRef.current || !canManage) {
        return;
      }
      setDraft((current) => ({ ...current, ...changes }));
      setFieldErrors({});
      setSubmitError(null);
    },
    [canManage, submitLockRef],
  );

  const submit = useCallback(async () => {
    if (submitLockRef.current || !canManage) {
      return;
    }

    const validation = validateSectionDraft(draft);
    setFieldErrors(validation.fieldErrors);
    setSubmitError(null);
    if (
      !validation.isValid ||
      isUnavailableDate(
        timeline.sections,
        draft.section_date,
        editedSectionId,
      )
    ) {
      return;
    }

    const createPayload =
      intent.mode === 'create'
        ? buildCreateSectionPayload(draft)
        : null;
    const patchPayload =
      intent.mode === 'edit'
        ? buildPatchSectionPayload(initial, draft)
        : null;
    if (
      (intent.mode === 'create' && !createPayload) ||
      (intent.mode === 'edit' &&
        (!patchPayload || Object.keys(patchPayload).length === 0))
    ) {
      return;
    }

    const generation = getGeneration();
    submitLockRef.current = true;
    setSubmitting(true);
    invalidate();

    try {
      if (intent.mode === 'create' && createPayload) {
        await createSection(intent.tripId, createPayload);
      } else if (intent.mode === 'edit' && patchPayload) {
        await patchSection(intent.tripId, intent.sectionId, patchPayload);
      }
      submissionCommittedRef.current = true;

      await publishTimelineEvent({
        type: 'timelineChanged',
        tripId: intent.tripId,
      });
      if (isScreenActive()) {
        onConfirmedSuccess();
      }
    } catch (caught) {
      if (submissionCommittedRef.current) {
        if (isScreenActive()) {
          onConfirmedSuccess();
        }
        return;
      }
      if (!mountedRef.current || !isActiveGeneration(generation)) {
        return;
      }
      const normalized = normalizeApiError(caught);
      setSubmitError(normalized);
      if (shouldReconcileAfterFailure(normalized)) {
        await refresh('silent');
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
    canManage,
    draft,
    editedSectionId,
    getGeneration,
    initial,
    intent,
    invalidate,
    isActiveGeneration,
    isScreenActive,
    onConfirmedSuccess,
    refresh,
    setSubmitting,
    submitLockRef,
    submissionCommittedRef,
    timeline.sections,
  ]);

  const title = intent.mode === 'create' ? 'Add Day' : 'Edit Day';

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
      <SectionForm
        mode={intent.mode}
        draft={draft}
        fieldErrors={fieldErrors}
        submitError={submitError}
        dateUnavailable={dateUnavailable}
        dirty={dirty}
        submitting={submitting}
        disabled={!canManage}
        authorityMessage={
          canManage
            ? undefined
            : 'You do not have permission to manage timeline days.'
        }
        onChange={changeDraft}
        onSubmit={() => void submit()}
      />
    </>
  );
}

function ValidSectionFormScreen({
  intent,
}: {
  intent: SectionFormRouteIntent;
}) {
  const router = useRouter();
  const {
    timeline,
    status,
    error: loadError,
    refresh,
    invalidate,
  } = useTimeline(intent.tripId, { autoReconcile: false });
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const submissionCommittedRef = useRef(false);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const hasRequestedInitialRef = useRef(false);
  const parentHref = `/trips/${intent.tripId}/timeline` as const;
  const currentSection =
    intent.mode === 'edit'
      ? timeline?.sections.find((section) => section.id === intent.sectionId)
      : undefined;

  const requestReconcile = useCallback(
    (forceInitial = false) => {
      const mode =
        forceInitial || !hasRequestedInitialRef.current
          ? 'initial'
          : 'silent';
      hasRequestedInitialRef.current = true;
      return refresh(mode);
    },
    [refresh],
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
      if (activeRef.current && !submitLockRef.current) {
        void requestReconcile();
      }
    }, [requestReconcile]),
  );

  useEffect(
    () =>
      subscribeToTimelineEvents(intent.tripId, () => {
        if (activeRef.current && !submissionCommittedRef.current) {
          return requestReconcile();
        }
        return undefined;
      }),
    [intent.tripId, requestReconcile],
  );

  const canManage =
    intent.mode === 'create'
      ? timeline?.permissions.can_create_sections === true
      : timeline?.permissions.can_edit_timeline === true;

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

  const title = intent.mode === 'create' ? 'Add Day' : 'Edit Day';

  if (!timeline && status === 'loading') {
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
        <LoadingScreen />
      </>
    );
  }

  if (!timeline) {
    const notFound = loadError?.status === 404;
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
        <SectionFormState
          title={notFound ? 'Timeline unavailable' : 'Could not load timeline'}
          message={
            notFound
              ? 'This trip does not exist or you are not a member of it.'
              : loadError?.message ?? 'Please try again.'
          }
          actionTitle={notFound ? 'Back to timeline' : 'Try again'}
          onAction={
            notFound ? cancel : () => void requestReconcile(true)
          }
        />
      </>
    );
  }

  if (intent.mode === 'edit' && !currentSection) {
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
        <SectionFormState
          title="Day unavailable"
          message="This timeline day no longer exists."
          actionTitle="Back to timeline"
          onAction={cancel}
        />
      </>
    );
  }

  const initialDraft =
    intent.mode === 'edit'
      ? hydrateSectionDraft(currentSection!)
      : createSectionDraft(
          getTodayDateInTimeZone(timeline.trip_timezone),
        );

  return (
    <>
      {loadError ? (
        <View accessibilityRole="alert" style={styles.refreshError}>
          <Text style={styles.refreshErrorText}>{loadError.message}</Text>
        </View>
      ) : null}
      <SectionFormEditor
        intent={intent}
        timeline={timeline}
        initialDraft={initialDraft}
        canManage={canManage}
        submitLockRef={submitLockRef}
        submissionCommittedRef={submissionCommittedRef}
        submitting={submitting}
        setSubmitting={setSubmitting}
        invalidate={invalidate}
        refresh={refresh}
        getGeneration={getGeneration}
        isScreenActive={isScreenActive}
        isActiveGeneration={isActiveGeneration}
        onCancel={cancel}
        onConfirmedSuccess={() => router.dismissTo(parentHref)}
      />
    </>
  );
}

export function SectionFormScreen() {
  const { tripId, mode, sectionId } = useLocalSearchParams();
  const intent = parseSectionFormRouteIntent({ tripId, mode, sectionId });

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
      : `${intent.tripId}:edit:${intent.sectionId}`;
  return <ValidSectionFormScreen key={identity} intent={intent} />;
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
  stateBody: {
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
  headerActionMuted: { opacity: 0.55 },
  headerActionText: { ...typography.body, color: colors.primary },
  refreshError: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.dangerSoft,
  },
  refreshErrorText: {
    ...typography.caption,
    color: colors.danger,
  },
});
