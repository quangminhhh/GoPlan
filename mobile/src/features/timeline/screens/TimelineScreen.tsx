import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
  type SectionListRenderItemInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { deleteSection as deleteTimelineSection } from '../api';
import { ActivityRow } from '../components/ActivityRow';
import { SectionGroup } from '../components/SectionGroup';
import { useTimeline } from '../hooks/useTimeline';
import { parseTimelineRouteIntent } from '../routeIntent';
import { publishTimelineEvent } from '../timelineEvents';
import type { TimelineSection } from '../types';
import {
  buildTimelineListSections,
  getDefaultFocusedSectionIndex,
  getTimelineRowKey,
  type TimelineListRow,
  type TimelineListSection,
} from '../viewModel';
import { RouteUnavailableState } from './RouteState';

interface TimelineContentProps {
  tripId: string;
}

interface ScrollFailureInfo {
  index: number;
  highestMeasuredFrameIndex: number;
  averageItemLength: number;
}

function TimelineContent({ tripId }: TimelineContentProps) {
  const router = useRouter();
  const {
    timeline,
    status,
    error,
    refreshing,
    refresh,
    invalidate,
  } = useTimeline(tripId);
  const listRef =
    useRef<SectionList<TimelineListRow, TimelineListSection>>(null);
  const mountedRef = useRef(true);
  const deleteLockRef = useRef(false);
  const deleteStartedRef = useRef(false);
  const lastScrollTripIdRef = useRef<string | null>(null);
  const scrollTargetRef = useRef<{
    tripId: string;
    sectionIndex: number;
    retried: boolean;
  } | null>(null);
  const retryFrameRef = useRef<number | null>(null);
  const [sectionActionsLocked, setSectionActionsLocked] = useState(false);
  const [deletingSectionId, setDeletingSectionId] = useState<string | null>(
    null,
  );
  const [mutationError, setMutationError] = useState<string | null>(null);
  const sections = useMemo(
    () => buildTimelineListSections(timeline?.sections ?? []),
    [timeline?.sections],
  );

  useEffect(() => {
    if (
      status !== 'ready' ||
      !timeline ||
      sections.length === 0 ||
      lastScrollTripIdRef.current === tripId
    ) {
      return;
    }

    const sectionIndex = getDefaultFocusedSectionIndex(
      sections,
      timeline.trip_timezone,
    );
    if (sectionIndex === null) {
      return;
    }

    lastScrollTripIdRef.current = tripId;
    scrollTargetRef.current = {
      tripId,
      sectionIndex,
      retried: false,
    };
    listRef.current?.scrollToLocation({
      animated: false,
      sectionIndex,
      itemIndex: 0,
      viewPosition: 0,
    });
  }, [sections, status, timeline, tripId]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (retryFrameRef.current !== null) {
        cancelAnimationFrame(retryFrameRef.current);
        retryFrameRef.current = null;
      }
    },
    [tripId],
  );

  const retryInitialLoad = useCallback(() => {
    void refresh('initial');
  }, [refresh]);

  const retryBackgroundLoad = useCallback(() => {
    void refresh('silent');
  }, [refresh]);

  const pullToRefresh = useCallback(() => {
    void refresh('refresh');
  }, [refresh]);

  const recoverFailedInitialScroll = useCallback(
    ({ averageItemLength, index }: ScrollFailureInfo) => {
      const target = scrollTargetRef.current;
      if (!target || target.tripId !== tripId || target.retried) {
        return;
      }

      target.retried = true;
      listRef.current?.getScrollResponder()?.scrollTo({
        animated: false,
        y: Math.max(0, averageItemLength * index),
      });
      retryFrameRef.current = requestAnimationFrame(() => {
        retryFrameRef.current = null;
        if (scrollTargetRef.current !== target) {
          return;
        }
        listRef.current?.scrollToLocation({
          animated: false,
          sectionIndex: target.sectionIndex,
          itemIndex: 0,
          viewPosition: 0,
        });
      });
    },
    [tripId],
  );

  const openCreateDay = useCallback(() => {
    setMutationError(null);
    router.push(`/trips/${tripId}/timeline/section-form?mode=create`);
  }, [router, tripId]);

  const openEditSection = useCallback(
    (section: TimelineSection) => {
      setMutationError(null);
      router.push(
        `/trips/${tripId}/timeline/section-form?mode=edit&sectionId=${section.id}`,
      );
    },
    [router, tripId],
  );

  const performDeleteSection = useCallback(
    async (section: TimelineSection) => {
      if (!mountedRef.current) {
        deleteStartedRef.current = false;
        deleteLockRef.current = false;
        return;
      }

      setDeletingSectionId(section.id);
      setMutationError(null);
      invalidate();

      try {
        await deleteTimelineSection(tripId, section.id);
        await publishTimelineEvent({
          type: 'timelineChanged',
          tripId,
        });
      } catch (caught) {
        if (!mountedRef.current) {
          return;
        }

        const normalized = normalizeApiError(caught);
        setMutationError(normalized.message);
        if (
          normalized.status === 403 ||
          normalized.status === 404 ||
          normalized.status === 409
        ) {
          await refresh('silent');
        }
      } finally {
        deleteStartedRef.current = false;
        deleteLockRef.current = false;
        if (mountedRef.current) {
          setDeletingSectionId(null);
          setSectionActionsLocked(false);
        }
      }
    },
    [invalidate, refresh, tripId],
  );

  const confirmDeleteSection = useCallback(
    (section: TimelineSection) => {
      if (deleteLockRef.current) {
        return;
      }

      deleteLockRef.current = true;
      deleteStartedRef.current = false;
      setSectionActionsLocked(true);
      setMutationError(null);
      const releasePrompt = () => {
        if (deleteStartedRef.current) {
          return;
        }
        deleteStartedRef.current = false;
        deleteLockRef.current = false;
        if (mountedRef.current) {
          setSectionActionsLocked(false);
        }
      };
      Alert.alert(
        'Delete timeline day?',
        `Delete ${section.label} and all activities in it? This cannot be undone.`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: releasePrompt,
          },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              if (deleteStartedRef.current) {
                return;
              }
              deleteStartedRef.current = true;
              void performDeleteSection(section);
            },
          },
        ],
        {
          cancelable: true,
          onDismiss: releasePrompt,
        },
      );
    },
    [performDeleteSection],
  );

  const renderItem = useCallback(
    ({
      item,
    }: SectionListRenderItemInfo<
      TimelineListRow,
      TimelineListSection
    >) => {
      if (item.type === 'group-header') {
        return (
          <Text accessibilityRole="header" style={styles.groupHeader}>
            {item.label}
          </Text>
        );
      }

      if (item.type === 'empty') {
        return <Text style={styles.dayEmpty}>No activities yet.</Text>;
      }

      return <ActivityRow activity={item.activity} />;
    },
    [],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: TimelineListSection }) => (
      <SectionGroup
        section={section.section}
        canEdit={timeline?.permissions.can_edit_timeline === true}
        canDelete={timeline?.permissions.can_edit_timeline === true}
        actionsDisabled={sectionActionsLocked}
        onEdit={openEditSection}
        onDelete={confirmDeleteSection}
      />
    ),
    [
      confirmDeleteSection,
      openEditSection,
      sectionActionsLocked,
      timeline?.permissions.can_edit_timeline,
    ],
  );

  if (status === 'loading') {
    return <LoadingScreen />;
  }

  if (status === 'error' || !timeline) {
    const isNotFound = error?.status === 404;
    return (
      <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
        <Stack.Screen options={{ title: 'Timeline' }} />
        <View style={styles.centered}>
          <Ionicons
            name={isNotFound ? 'help-circle-outline' : 'cloud-offline-outline'}
            size={44}
            color={colors.textMuted}
          />
          <Text accessibilityRole="header" style={styles.errorTitle}>
            {isNotFound ? 'Timeline not found' : 'Could not load timeline'}
          </Text>
          <Text style={styles.centeredMessage}>
            {isNotFound
              ? 'This trip does not exist or you no longer have access to it.'
              : error?.message ?? 'Timeline is unavailable.'}
          </Text>
          <Button title="Try again" onPress={retryInitialLoad} />
        </View>
      </SafeAreaView>
    );
  }

  const canCreateSections = timeline.permissions.can_create_sections;

  return (
    <SafeAreaView
      testID="timeline-route-ready"
      style={styles.safe}
      edges={['left', 'right', 'bottom']}
    >
      <Stack.Screen options={{ title: 'Timeline' }} />
      <SectionList<TimelineListRow, TimelineListSection>
        ref={listRef}
        testID="timeline-list"
        sections={sections}
        keyExtractor={getTimelineRowKey}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        onScrollToIndexFailed={recoverFailedInitialScroll}
        stickySectionHeadersEnabled
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.listContent,
          sections.length === 0 ? styles.emptyListContent : null,
        ]}
        refreshControl={
          <RefreshControl
            testID="timeline-refresh-control"
            refreshing={refreshing}
            onRefresh={pullToRefresh}
          />
        }
        ListHeaderComponent={
          error || mutationError || deletingSectionId ? (
            <View>
              {error ? (
                <View accessibilityRole="alert" style={styles.inlineError}>
                  <Ionicons
                    name="alert-circle-outline"
                    size={20}
                    color={colors.danger}
                  />
                  <Text style={styles.inlineErrorText}>{error.message}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry refreshing timeline"
                    onPress={retryBackgroundLoad}
                    style={({ pressed }) => [
                      styles.retryButton,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={styles.retryText}>Retry</Text>
                  </Pressable>
                </View>
              ) : null}
              {mutationError ? (
                <View accessibilityRole="alert" style={styles.inlineError}>
                  <Ionicons
                    name="alert-circle-outline"
                    size={20}
                    color={colors.danger}
                  />
                  <Text style={styles.inlineErrorText}>{mutationError}</Text>
                </View>
              ) : null}
              {deletingSectionId ? (
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel="Deleting timeline day"
                  style={styles.mutationProgress}
                >
                  <ActivityIndicator color={colors.primary} />
                  <Text style={styles.mutationProgressText}>
                    Deleting timeline day…
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name="calendar-outline"
              size={44}
              color={colors.textMuted}
            />
            <Text accessibilityRole="header" style={styles.errorTitle}>
              No days yet
            </Text>
            <Text style={styles.centeredMessage}>
              Add the first day to start planning this trip.
            </Text>
            {canCreateSections ? (
              <Button title="Add day" onPress={openCreateDay} />
            ) : null}
          </View>
        }
        ListFooterComponent={
          sections.length > 0 && canCreateSections ? (
            <View style={styles.footerAction}>
              <Button
                title="Add day"
                disabled={sectionActionsLocked}
                onPress={openCreateDay}
              />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

export function TimelineScreen() {
  const { tripId } = useLocalSearchParams();
  const intent = parseTimelineRouteIntent({ tripId });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Timeline unavailable"
        message="This timeline link is invalid or incomplete."
      />
    );
  }

  return <TimelineContent key={intent.tripId} tripId={intent.tripId} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  errorTitle: { ...typography.heading, color: colors.text, textAlign: 'center' },
  centeredMessage: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
  listContent: { paddingBottom: spacing.xl },
  emptyListContent: { flexGrow: 1 },
  inlineError: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    margin: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  inlineErrorText: { ...typography.caption, color: colors.danger, flex: 1 },
  retryButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  retryText: { ...typography.label, color: colors.danger },
  groupHeader: {
    ...typography.label,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    backgroundColor: colors.surface,
  },
  dayEmpty: {
    ...typography.body,
    color: colors.textMuted,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    textAlign: 'center',
    backgroundColor: colors.background,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  mutationProgress: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  mutationProgressText: { ...typography.caption, color: colors.textMuted },
  footerAction: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  pressed: { opacity: 0.55 },
});
