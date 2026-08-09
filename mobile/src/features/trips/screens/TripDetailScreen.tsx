import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { type ComponentProps, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { resolveMediaUrl } from '@/shared/api/base-url';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { cancelTrip, completeTrip, leaveTrip, removeTripMember, startTrip } from '../api';
import { MemberRow } from '../components/MemberRow';
import { PendingInvitationRow } from '../components/PendingInvitationRow';
import { StatusBadge } from '../components/StatusBadge';
import { TripActions, type TripDisplayAction } from '../components/TripActions';
import { formatDateRange } from '../dates';
import { usePendingInvitations } from '../hooks/usePendingInvitations';
import { useTripDetail } from '../hooks/useTripDetail';
import { publishTripEvent } from '../tripEvents';

const budgetFormatter = new Intl.NumberFormat('en-US');

function formatBudget(budget: string, currencyCode: string): string {
  const amount = Number(budget);
  if (Number.isNaN(amount)) {
    return `${budget} ${currencyCode}`;
  }
  return `${budgetFormatter.format(amount)} ${currencyCode}`;
}

interface DetailRowProps {
  icon: ComponentProps<typeof Ionicons>['name'];
  value: string;
  showDivider?: boolean;
}

function DetailRow({ icon, value, showDivider = false }: DetailRowProps) {
  return (
    <View style={[styles.infoRow, showDivider && styles.rowDivider]}>
      <View style={styles.infoIcon}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <Text style={styles.infoText}>{value}</Text>
    </View>
  );
}

export function TripDetailScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const router = useRouter();
  const { detail, status, error, refreshing, refresh, applyStatus } = useTripDetail(tripId);
  const captainControlsEnabled = Boolean(
    detail?.my_membership.role === 'CAPTAIN' && detail.my_membership.status === 'ACTIVE',
  );
  const pendingInvitations = usePendingInvitations(tripId, captainControlsEnabled);
  const [mutationError, setMutationError] = useState<ApiError | null>(null);
  const [mutatingAction, setMutatingAction] = useState<TripDisplayAction | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const mutationLockRef = useRef(false);

  const handleAction = useCallback(
    async (action: TripDisplayAction) => {
      if (action === 'edit') {
        router.push(`/trips/${tripId}/edit`);
        return;
      }
      if (!tripId || mutationLockRef.current) {
        return;
      }

      mutationLockRef.current = true;
      setMutationError(null);
      setMutatingAction(action);
      try {
        if (action === 'leave') {
          await leaveTrip(tripId);
          publishTripEvent({ type: 'removed', tripId });
          router.dismissTo('/(tabs)');
          return;
        }

        const nextStatus =
          action === 'start'
            ? await startTrip(tripId)
            : action === 'complete'
              ? await completeTrip(tripId)
              : await cancelTrip(tripId);
        applyStatus(nextStatus);
        publishTripEvent({ type: 'statusChanged', tripId, status: nextStatus });
        void refresh('silent');
      } catch (caught) {
        setMutationError(normalizeApiError(caught));
      } finally {
        mutationLockRef.current = false;
        setMutatingAction(null);
      }
    },
    [applyStatus, refresh, router, tripId],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      if (!tripId) {
        mutationLockRef.current = false;
        return;
      }
      setMutationError(null);
      setRemovingMemberId(userId);
      try {
        await removeTripMember(tripId, userId);
        publishTripEvent({ type: 'memberRemoved', tripId, userId });
        void refresh('silent');
      } catch (caught) {
        setMutationError(normalizeApiError(caught));
      } finally {
        mutationLockRef.current = false;
        setRemovingMemberId(null);
      }
    },
    [refresh, tripId],
  );

  const confirmMemberRemoval = useCallback(
    (userId: string, displayName: string) => {
      if (!tripId || mutationLockRef.current) {
        return;
      }
      mutationLockRef.current = true;
      let confirmed = false;
      const releaseLock = () => {
        mutationLockRef.current = false;
      };
      Alert.alert(
        'Remove trip member?',
        `Remove ${displayName} from this trip? They will lose access immediately.`,
        [
          { text: 'Keep member', style: 'cancel', onPress: releaseLock },
          {
            text: 'Remove member',
            style: 'destructive',
            onPress: () => {
              confirmed = true;
              void removeMember(userId);
            },
          },
        ],
        {
          cancelable: true,
          onDismiss: () => {
            if (!confirmed) {
              releaseLock();
            }
          },
        },
      );
    },
    [removeMember, tripId],
  );

  const openInvite = useCallback(() => {
    router.push(`/trips/${tripId}/invite`);
  }, [router, tripId]);

  const openTimeline = useCallback(() => {
    router.push(`/trips/${tripId}/timeline`);
  }, [router, tripId]);

  const openChat = useCallback(() => {
    router.push(`/trips/${tripId}/chat`);
  }, [router, tripId]);

  const openExpenses = useCallback(() => {
    router.push(`/trips/${tripId}/expenses`);
  }, [router, tripId]);

  const openPhotos = useCallback(() => {
    router.push(`/trips/${tripId}/photos`);
  }, [router, tripId]);

  if (status === 'loading') {
    return <LoadingScreen />;
  }

  if (status === 'error' || !detail) {
    const displayError = error ?? normalizeApiError(new Error('Missing trip detail.'));
    const notFound = displayError.status === 404;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <Ionicons name={notFound ? 'help-circle-outline' : 'cloud-offline-outline'} size={44} color={colors.textMuted} />
          <Text style={styles.sectionTitle}>{notFound ? 'Trip not found' : 'Could not load trip'}</Text>
          <Text style={styles.muted}>
            {notFound ? 'This trip does not exist or you are not a member of it.' : displayError.message}
          </Text>
          {notFound ? null : <Button title="Try again" onPress={() => void refresh('initial')} />}
        </View>
      </SafeAreaView>
    );
  }

  const { trip, members, my_membership: membership } = detail;
  const coverUrl = resolveMediaUrl(trip.cover_image_url || null);
  const inlineError = mutationError ?? error;
  const isNonTerminal = trip.status === 'PLANNING' || trip.status === 'ONGOING';
  const canInvite = captainControlsEnabled && isNonTerminal;
  const canRemoveMembers = captainControlsEnabled && isNonTerminal;
  const mutationInFlight = mutatingAction !== null || removingMemberId !== null;

  return (
    <SafeAreaView style={styles.safe} edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: trip.name }} />
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {inlineError ? (
          <View accessibilityRole="alert" style={styles.inlineError}>
            <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
            <Text style={styles.inlineErrorText}>{inlineError.message}</Text>
            {!mutationError ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry refreshing trip"
                hitSlop={spacing.sm}
                onPress={() => void refresh('silent')}
                style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {refreshing ? (
          <View accessibilityLabel="Refreshing trip" style={styles.refreshingRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.refreshingText}>Refreshing…</Text>
          </View>
        ) : null}
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={styles.cover} contentFit="cover" transition={150} />
        ) : (
          <View style={styles.coverFallback}>
            <Ionicons name="airplane-outline" size={32} color={colors.primary} />
          </View>
        )}
        <View style={styles.sectionHeader}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Overview
          </Text>
          <StatusBadge status={trip.status} />
        </View>
        <View style={styles.card}>
          <DetailRow icon="location-outline" value={trip.destination} showDivider />
          <DetailRow
            icon="calendar-outline"
            value={formatDateRange(trip.start_date, trip.end_date)}
            showDivider={Boolean(trip.budget_estimate)}
          />
          {trip.budget_estimate ? (
            <DetailRow icon="wallet-outline" value={formatBudget(trip.budget_estimate, trip.currency_code)} />
          ) : null}
        </View>
        <TripActions
          trip={trip}
          membership={membership}
          isMutating={mutationInFlight}
          onAction={handleAction}
        />
        {mutatingAction ? (
          <View accessibilityLabel="Updating trip" style={styles.refreshingRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.refreshingText}>Updating trip…</Text>
          </View>
        ) : null}
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Planning
          </Text>
          <View style={styles.card}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Chat"
              onPress={openChat}
              style={({ pressed }) => [
                styles.planningRow,
                styles.rowDivider,
                pressed ? styles.planningRowPressed : null,
              ]}
            >
              <View style={styles.infoIcon}>
                <Ionicons name="chatbubbles-outline" size={18} color={colors.primary} />
              </View>
              <View style={styles.planningCopy}>
                <Text style={styles.infoText}>Chat</Text>
                <Text style={styles.planningDescription}>
                  Message trip members in real time
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Timeline"
              onPress={openTimeline}
              style={({ pressed }) => [
                styles.planningRow,
                styles.rowDivider,
                pressed ? styles.planningRowPressed : null,
              ]}
            >
              <View style={styles.infoIcon}>
                <Ionicons name="calendar-outline" size={18} color={colors.primary} />
              </View>
              <View style={styles.planningCopy}>
                <Text style={styles.infoText}>Timeline</Text>
                <Text style={styles.planningDescription}>
                  Plan days, activities, and reminders
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Expenses"
              onPress={openExpenses}
              style={({ pressed }) => [
                styles.planningRow,
                styles.rowDivider,
                pressed ? styles.planningRowPressed : null,
              ]}
            >
              <View style={styles.infoIcon}>
                <Ionicons name="wallet-outline" size={18} color={colors.primary} />
              </View>
              <View style={styles.planningCopy}>
                <Text style={styles.infoText}>Expenses</Text>
                <Text style={styles.planningDescription}>
                  Track shared costs and settlement
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Photos"
              onPress={openPhotos}
              style={({ pressed }) => [
                styles.planningRow,
                pressed ? styles.planningRowPressed : null,
              ]}
            >
              <View style={styles.infoIcon}>
                <Ionicons name="images-outline" size={18} color={colors.primary} />
              </View>
              <View style={styles.planningCopy}>
                <Text style={styles.infoText}>Photos</Text>
                <Text style={styles.planningDescription}>
                  Browse and share trip photos
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>
        {trip.description ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Description
            </Text>
            <View style={styles.card}>
              <Text style={styles.description}>{trip.description}</Text>
            </View>
          </View>
        ) : null}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Members ({members.length})
            </Text>
          </View>
          <View style={[styles.card, styles.membersCard]}>
            {members.map((member, index) => (
              <MemberRow
                key={member.membership_id}
                member={member}
                showDivider={index < members.length - 1}
                showRemove={canRemoveMembers && member.role !== 'CAPTAIN'}
                removeDisabled={mutationInFlight}
                removing={removingMemberId === member.user.id}
                onRemoveRequest={confirmMemberRemoval}
              />
            ))}
          </View>
        </View>
        {captainControlsEnabled ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                Pending invitations
              </Text>
              {canInvite ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Invite friends"
                  disabled={mutationInFlight}
                  onPress={openInvite}
                  style={({ pressed }) => [
                    styles.inviteButton,
                    pressed && !mutationInFlight ? styles.inviteButtonPressed : null,
                    mutationInFlight ? styles.inviteButtonDisabled : null,
                  ]}
                >
                  <Ionicons name="person-add-outline" size={18} color={colors.primary} />
                  <Text style={styles.inviteButtonText}>Invite</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={[styles.card, styles.pendingCard]}>
              {pendingInvitations.status === 'loading' || pendingInvitations.status === 'idle' ? (
                <View accessibilityLabel="Loading pending invitations" style={styles.pendingState}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.pendingStateText}>Loading invitations…</Text>
                </View>
              ) : pendingInvitations.status === 'error' ? (
                <View accessibilityRole="alert" style={styles.pendingState}>
                  <Text style={styles.pendingErrorText}>{pendingInvitations.error?.message}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry pending invitations"
                    onPress={() => void pendingInvitations.load('initial')}
                    style={({ pressed }) => [styles.pendingRetry, pressed ? styles.retryButtonPressed : null]}
                  >
                    <Text style={styles.retryText}>Try again</Text>
                  </Pressable>
                </View>
              ) : pendingInvitations.items.length === 0 ? (
                <Text style={styles.pendingEmpty}>No pending invitations.</Text>
              ) : (
                pendingInvitations.items.map((invitation, index) => (
                  <PendingInvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    showDivider={index < pendingInvitations.items.length - 1}
                  />
                ))
              )}
              {pendingInvitations.status === 'ready' && pendingInvitations.error ? (
                <View accessibilityRole="alert" style={styles.pendingInlineError}>
                  <Text style={styles.pendingErrorText}>{pendingInvitations.error.message}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry pending invitations"
                    onPress={() => void pendingInvitations.load('silent')}
                    style={({ pressed }) => [styles.pendingRetry, pressed ? styles.retryButtonPressed : null]}
                  >
                    <Text style={styles.retryText}>Retry</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.lg },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  cover: { height: 180, width: '100%', borderRadius: radii.lg },
  coverFallback: {
    height: 80,
    width: '100%',
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  section: { gap: spacing.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  card: {
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
  },
  infoRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  infoIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  infoText: { ...typography.body, color: colors.text, flexShrink: 1 },
  planningRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  planningRowPressed: { opacity: 0.55 },
  planningCopy: { flex: 1, gap: spacing.xs },
  planningDescription: { ...typography.caption, color: colors.textMuted },
  description: { ...typography.body, color: colors.text, paddingVertical: spacing.md },
  sectionTitle: { ...typography.heading, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  membersCard: { paddingVertical: 0 },
  inlineError: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    backgroundColor: colors.dangerSoft,
  },
  inlineErrorText: { ...typography.caption, color: colors.danger, flex: 1 },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  retryButtonPressed: { opacity: 0.55 },
  retryText: { ...typography.label, color: colors.danger },
  refreshingRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  refreshingText: { ...typography.caption, color: colors.textMuted },
  inviteButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
  },
  inviteButtonPressed: { opacity: 0.55 },
  inviteButtonDisabled: { opacity: 0.5 },
  inviteButtonText: { ...typography.label, color: colors.primary },
  pendingCard: { paddingVertical: 0 },
  pendingState: {
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  pendingStateText: { ...typography.caption, color: colors.textMuted },
  pendingErrorText: { ...typography.caption, color: colors.danger, textAlign: 'center' },
  pendingRetry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
  pendingEmpty: { ...typography.body, color: colors.textMuted, paddingVertical: spacing.md },
  pendingInlineError: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.dangerBorder,
  },
});
