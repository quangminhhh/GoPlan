import { Ionicons } from '@expo/vector-icons';
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import {
  createCustomType,
  deleteCustomType,
  patchCustomType,
} from '../api';
import {
  CustomTypeManager,
  type CustomTypeMutationError,
  type CustomTypeMutationScope,
} from '../components/CustomTypeManager';
import {
  buildCreateCustomTypePayload,
  buildPatchCustomTypePayload,
  createCustomTypeDraft,
  hydrateCustomTypeDraft,
  type CustomTypeDraft,
  type CustomTypeFieldErrors,
  validateCustomTypeDraft,
} from '../customTypeModel';
import {
  type TimelineLoadMode,
  useTimeline,
} from '../hooks/useTimeline';
import { parseTimelineRouteIntent } from '../routeIntent';
import {
  publishTimelineEvent,
  subscribeToTimelineEvents,
} from '../timelineEvents';
import type { TimelineCustomTypeMeta } from '../types';
import { RouteUnavailableState } from './RouteState';

interface EditState {
  typeId: string;
  initial: CustomTypeDraft;
  draft: CustomTypeDraft;
}

interface ManagerStateProps {
  title: string;
  message: string;
  actionTitle?: string;
  onAction?: () => void;
}

function ManagerState({
  title,
  message,
  actionTitle,
  onAction,
}: ManagerStateProps) {
  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <View style={styles.centered}>
        <Ionicons
          name="pricetags-outline"
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

function HeaderCloseAction({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close custom types"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={spacing.sm}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerAction,
        (pressed || disabled) ? styles.headerActionMuted : null,
      ]}
    >
      <Text style={styles.headerActionText}>Close</Text>
    </Pressable>
  );
}

function ManagerNavigation({
  busy,
  onClose,
}: {
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <Stack.Screen
      options={{
        title: 'Custom Types',
        gestureEnabled: !busy,
        headerLeft: () => (
          <HeaderCloseAction disabled={busy} onPress={onClose} />
        ),
      }}
    />
  );
}

function shouldReconcileAfterFailure(error: ApiError): boolean {
  return error.status === 403 || error.status === 404 || error.status === 409;
}

function mutationKeyForScope(scope: CustomTypeMutationScope): string {
  return scope.kind === 'create'
    ? 'create'
    : `${scope.kind}:${scope.typeId}`;
}

function hasPayloadFields(payload: object | null): boolean {
  return payload !== null && Object.keys(payload).length > 0;
}

function ValidCustomTypeManagerScreen({ tripId }: { tripId: string }) {
  const router = useRouter();
  const {
    timeline,
    status,
    error: loadError,
    refresh,
    invalidate,
  } = useTimeline(tripId, { autoReconcile: false });
  const [createDraft, setCreateDraft] = useState(createCustomTypeDraft);
  const [createFieldErrors, setCreateFieldErrors] =
    useState<CustomTypeFieldErrors>({});
  const [editState, setEditState] = useState<EditState | null>(null);
  const [editFieldErrors, setEditFieldErrors] =
    useState<CustomTypeFieldErrors>({});
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const [mutationError, setMutationError] =
    useState<CustomTypeMutationError | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const mutationLockRef = useRef(false);
  const confirmationLockRef = useRef(false);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const hasRequestedInitialRef = useRef(false);
  const parentHref = `/trips/${tripId}/timeline` as const;

  const requestReconcile = useCallback(
    (forceInitial = false): Promise<void> => {
      const mode: TimelineLoadMode =
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
      if (!mutationLockRef.current) {
        setMutationKey(null);
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
      if (activeRef.current && !mutationLockRef.current) {
        void requestReconcile();
      }
    }, [requestReconcile]),
  );

  useEffect(
    () =>
      subscribeToTimelineEvents(tripId, () => {
        if (activeRef.current) {
          return requestReconcile();
        }
        return undefined;
      }),
    [requestReconcile, tripId],
  );

  const isActiveGeneration = useCallback((generation: number): boolean => {
    return (
      mountedRef.current &&
      activeRef.current &&
      generationRef.current === generation
    );
  }, []);

  const close = useCallback(() => {
    if (!mutationLockRef.current) {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.dismissTo(parentHref);
      }
    }
  }, [parentHref, router]);

  const clearFeedback = useCallback(() => {
    setMutationError(null);
    setSuccessMessage(null);
  }, []);

  const changeCreateDraft = useCallback(
    (changes: Partial<CustomTypeDraft>) => {
      setCreateDraft((current) => ({ ...current, ...changes }));
      setCreateFieldErrors({});
      clearFeedback();
    },
    [clearFeedback],
  );

  const startEdit = useCallback(
    (customType: TimelineCustomTypeMeta) => {
      if (mutationLockRef.current) {
        return;
      }
      const initial = hydrateCustomTypeDraft(customType);
      setEditState({
        typeId: customType.id,
        initial: { ...initial },
        draft: { ...initial },
      });
      setEditFieldErrors({});
      clearFeedback();
    },
    [clearFeedback],
  );

  const changeEditDraft = useCallback(
    (changes: Partial<CustomTypeDraft>) => {
      setEditState((current) =>
        current
          ? {
              ...current,
              draft: { ...current.draft, ...changes },
            }
          : current,
      );
      setEditFieldErrors({});
      clearFeedback();
    },
    [clearFeedback],
  );

  const cancelEdit = useCallback(() => {
    if (!mutationLockRef.current) {
      setEditState(null);
      setEditFieldErrors({});
      clearFeedback();
    }
  }, [clearFeedback]);

  const runMutation = useCallback(
    async (
      scope: CustomTypeMutationScope,
      mutate: () => Promise<unknown>,
      activeSuccessMessage: string,
      onActiveSuccess?: () => void,
    ): Promise<void> => {
      if (mutationLockRef.current) {
        return;
      }

      const generation = generationRef.current;
      mutationLockRef.current = true;
      setMutationKey(mutationKeyForScope(scope));
      setMutationError(null);
      setSuccessMessage(null);
      invalidate();

      try {
        await mutate();
        await publishTimelineEvent({
          type: 'timelineChanged',
          tripId,
        });
        if (isActiveGeneration(generation)) {
          onActiveSuccess?.();
          setSuccessMessage(activeSuccessMessage);
        }
      } catch (caught) {
        if (!isActiveGeneration(generation)) {
          return;
        }
        const normalized = normalizeApiError(caught);
        setMutationError({ scope, error: normalized });
        if (shouldReconcileAfterFailure(normalized)) {
          await refresh('silent');
        }
      } finally {
        mutationLockRef.current = false;
        if (mountedRef.current && activeRef.current) {
          setMutationKey(null);
        }
      }
    },
    [invalidate, isActiveGeneration, refresh, tripId],
  );

  const submitCreate = useCallback(() => {
    const validation = validateCustomTypeDraft(createDraft);
    setCreateFieldErrors(validation.fieldErrors);
    setMutationError(null);
    setSuccessMessage(null);
    const payload = buildCreateCustomTypePayload(createDraft);
    if (!validation.isValid || !payload) {
      return;
    }

    void runMutation(
      { kind: 'create' },
      () => createCustomType(tripId, payload),
      'Custom type created.',
      () => {
        setCreateDraft(createCustomTypeDraft());
        setCreateFieldErrors({});
      },
    );
  }, [createDraft, runMutation, tripId]);

  const submitEdit = useCallback(() => {
    if (!editState) {
      return;
    }

    const validation = validateCustomTypeDraft(editState.draft);
    setEditFieldErrors(validation.fieldErrors);
    setMutationError(null);
    setSuccessMessage(null);
    const payload = buildPatchCustomTypePayload(
      editState.initial,
      editState.draft,
    );
    if (
      !validation.isValid ||
      payload === null ||
      Object.keys(payload).length === 0
    ) {
      return;
    }

    void runMutation(
      { kind: 'edit', typeId: editState.typeId },
      () => patchCustomType(tripId, editState.typeId, payload),
      'Custom type updated.',
      () => {
        setEditState(null);
        setEditFieldErrors({});
      },
    );
  }, [editState, runMutation, tripId]);

  const toggleActive = useCallback(
    (customType: TimelineCustomTypeMeta) => {
      const nextActive = !customType.is_active;
      void runMutation(
        { kind: 'toggle', typeId: customType.id },
        () =>
          patchCustomType(tripId, customType.id, {
            is_active: nextActive,
          }),
        `Custom type ${nextActive ? 'activated' : 'deactivated'}.`,
      );
    },
    [runMutation, tripId],
  );

  const requestDelete = useCallback(
    (customType: TimelineCustomTypeMeta) => {
      if (mutationLockRef.current || confirmationLockRef.current) {
        return;
      }

      confirmationLockRef.current = true;
      const releaseConfirmation = () => {
        confirmationLockRef.current = false;
      };
      Alert.alert(
        'Delete custom type?',
        `Delete "${customType.name}" permanently?`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: releaseConfirmation,
          },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              releaseConfirmation();
              void runMutation(
                { kind: 'delete', typeId: customType.id },
                () => deleteCustomType(tripId, customType.id),
                'Custom type deleted.',
                () => {
                  setEditState((current) =>
                    current?.typeId === customType.id ? null : current,
                  );
                },
              );
            },
          },
        ],
        {
          cancelable: true,
          onDismiss: releaseConfirmation,
        },
      );
    },
    [runMutation, tripId],
  );

  const editPayload = editState
    ? buildPatchCustomTypePayload(editState.initial, editState.draft)
    : null;
  const editDirty = hasPayloadFields(editPayload);
  const busy = mutationKey !== null;

  if (!timeline && status === 'loading') {
    return (
      <>
        <ManagerNavigation busy={false} onClose={close} />
        <LoadingScreen />
      </>
    );
  }

  if (!timeline) {
    const notFound = loadError?.status === 404;
    return (
      <>
        <ManagerNavigation busy={false} onClose={close} />
        <ManagerState
          title={
            notFound
              ? 'Custom types unavailable'
              : 'Could not load custom types'
          }
          message={
            notFound
              ? 'This trip does not exist or you are not a member of it.'
              : loadError?.message ?? 'Please try again.'
          }
          actionTitle={notFound ? 'Back to timeline' : 'Try again'}
          onAction={
            notFound ? close : () => void requestReconcile(true)
          }
        />
      </>
    );
  }

  if (!timeline.permissions.can_manage_custom_types) {
    return (
      <>
        <ManagerNavigation busy={false} onClose={close} />
        <ManagerState
          title="Custom type management unavailable"
          message="You do not have permission to manage custom activity types."
          actionTitle="Back to timeline"
          onAction={close}
        />
      </>
    );
  }

  return (
    <>
      <ManagerNavigation busy={busy} onClose={close} />
      <SafeAreaView
        style={styles.safe}
        edges={['left', 'right', 'bottom']}
      >
        {loadError ? (
          <View accessibilityRole="alert" style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{loadError.message}</Text>
          </View>
        ) : null}
        {successMessage ? (
          <View
            accessibilityLiveRegion="polite"
            style={styles.successBanner}
          >
            <Text style={styles.successBannerText}>{successMessage}</Text>
          </View>
        ) : null}
        <CustomTypeManager
          customTypes={timeline.custom_types}
          createDraft={createDraft}
          createFieldErrors={createFieldErrors}
          editTypeId={editState?.typeId ?? null}
          editDraft={editState?.draft ?? null}
          editFieldErrors={editFieldErrors}
          editDirty={editDirty}
          mutationKey={mutationKey}
          mutationError={mutationError}
          onChangeCreate={changeCreateDraft}
          onCreate={submitCreate}
          onStartEdit={startEdit}
          onChangeEdit={changeEditDraft}
          onSaveEdit={submitEdit}
          onCancelEdit={cancelEdit}
          onToggleActive={toggleActive}
          onDelete={requestDelete}
        />
      </SafeAreaView>
    </>
  );
}

export function CustomTypeManagerScreen() {
  const { tripId } = useLocalSearchParams();
  const intent = parseTimelineRouteIntent({ tripId });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Custom types unavailable"
        message="This custom types link is invalid or incomplete."
      />
    );
  }

  return (
    <ValidCustomTypeManagerScreen
      key={intent.tripId}
      tripId={intent.tripId}
    />
  );
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
  errorBanner: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.dangerSoft,
  },
  errorBannerText: { ...typography.caption, color: colors.danger },
  successBanner: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.successSoft,
  },
  successBannerText: { ...typography.caption, color: colors.success },
});
