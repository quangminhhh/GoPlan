import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { useNotifications } from '../application/NotificationsProvider';
import { NotificationRow } from '../components/NotificationRow';
import type { InvitationAction, NotificationItem } from '../types';

const notificationKey = (item: NotificationItem) => item.id;

export function NotificationsScreen() {
  const router = useRouter();
  const {
    items,
    status,
    error,
    errorSource,
    refreshing,
    loadingMore,
    hasNextPage,
    unreadCount,
    lastKnownUnreadCount,
    markingAllRead,
    pendingReadIds,
    pendingInvitationActions,
    rowErrors,
    globalMutationError,
    refreshForFocus,
    refresh,
    loadMore,
    markRead,
    markAllRead,
    respondToInvitation,
  } = useNotifications();

  useFocusEffect(
    useCallback(() => {
      void refreshForFocus();
    }, [refreshForFocus]),
  );

  const hasUnread = useMemo(
    () =>
      (unreadCount ?? lastKnownUnreadCount ?? 0) > 0 ||
      items.some((item) => !item.is_read),
    [items, lastKnownUnreadCount, unreadCount],
  );

  const openNotification = useCallback(
    (notificationId: string, tripId: string | null) => {
      void markRead(notificationId);
      if (tripId) {
        router.push(`/trips/${tripId}`);
      }
    },
    [markRead, router],
  );

  const handleInvitationAction = useCallback(
    (notificationId: string, invitationId: string, tripId: string, action: InvitationAction) => {
      void respondToInvitation(notificationId, invitationId, tripId, action);
    },
    [respondToInvitation],
  );

  const renderItem = useCallback(
    ({ item }: { item: NotificationItem }) => (
      <NotificationRow
        notification={item}
        readPending={pendingReadIds.has(item.id)}
        pendingInvitationAction={pendingInvitationActions.get(item.id) ?? null}
        error={rowErrors.get(item.id) ?? null}
        onOpen={openNotification}
        onInvitationAction={handleInvitationAction}
      />
    ),
    [
      handleInvitationAction,
      openNotification,
      pendingInvitationActions,
      pendingReadIds,
      rowErrors,
    ],
  );

  const autoLoadMore = useCallback(() => {
    if (hasNextPage && errorSource !== 'loadMore') {
      void loadMore();
    }
  }, [errorSource, hasNextPage, loadMore]);

  const header = (
    <View style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>
        Notifications
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Mark all notifications as read"
        accessibilityState={{ disabled: !hasUnread || markingAllRead, busy: markingAllRead }}
        disabled={!hasUnread || markingAllRead}
        onPress={() => void markAllRead()}
        style={({ pressed }) => [
          styles.markAllButton,
          pressed && !markingAllRead ? styles.pressed : null,
          !hasUnread && !markingAllRead ? styles.disabledButton : null,
        ]}
      >
        {markingAllRead ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Text style={[styles.markAllText, !hasUnread ? styles.disabledText : null]}>Mark all read</Text>
        )}
      </Pressable>
    </View>
  );

  if (status === 'loading') {
    return (
      <SafeAreaView style={styles.safe}>
        {header}
        <LoadingScreen />
      </SafeAreaView>
    );
  }

  if (status === 'error') {
    return (
      <SafeAreaView style={styles.safe}>
        {header}
        <View style={styles.centered}>
          <Ionicons name="cloud-offline-outline" size={44} color={colors.textMuted} />
          <Text style={styles.stateTitle}>Could not load notifications</Text>
          <Text style={styles.stateBody}>{error?.message}</Text>
          <Button title="Try again" onPress={() => void refreshForFocus()} />
        </View>
      </SafeAreaView>
    );
  }

  const inlineError = globalMutationError ?? (errorSource === 'refresh' ? error : null);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {header}
      {inlineError ? (
        <View accessibilityRole="alert" style={styles.inlineError}>
          <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
          <Text style={styles.inlineErrorText}>{inlineError.message}</Text>
          {!globalMutationError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry refreshing notifications"
              onPress={() => void refresh()}
              style={({ pressed }) => [styles.retryButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FlatList
        style={styles.list}
        data={items}
        keyExtractor={notificationKey}
        renderItem={renderItem}
        contentContainerStyle={items.length === 0 ? styles.emptyContainer : styles.listContent}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        onEndReached={autoLoadMore}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="notifications-off-outline" size={44} color={colors.textMuted} />
            <Text style={styles.stateTitle}>No notifications yet</Text>
            <Text style={styles.stateBody}>Trip updates and friend activity will appear here.</Text>
          </View>
        }
        ListFooterComponent={
          errorSource === 'loadMore' && error ? (
            <View accessibilityRole="alert" style={styles.footerError}>
              <Text style={styles.footerErrorText}>{error.message}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading more notifications"
                onPress={() => void loadMore()}
                style={({ pressed }) => [styles.retryButton, pressed ? styles.pressed : null]}
              >
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : loadingMore ? (
            <ActivityIndicator style={styles.footerSpinner} color={colors.primary} />
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  title: { ...typography.largeTitle, color: colors.text, flexShrink: 1 },
  markAllButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.primarySoft,
  },
  disabledButton: { backgroundColor: colors.surface },
  markAllText: { ...typography.label, color: colors.primary },
  disabledText: { color: colors.textMuted },
  pressed: { opacity: 0.55 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  emptyState: { alignItems: 'center', gap: spacing.md },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  stateTitle: { ...typography.heading, color: colors.text },
  stateBody: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  inlineError: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.dangerSoft,
  },
  inlineErrorText: { ...typography.caption, color: colors.danger, flex: 1 },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  retryText: { ...typography.label, color: colors.danger },
  footerSpinner: { marginVertical: spacing.md },
  footerError: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
  footerErrorText: { ...typography.caption, color: colors.danger, textAlign: 'center' },
});
