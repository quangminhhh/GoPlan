import { useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { Screen } from '@/shared/ui/Screen';
import { PhotoGrid } from '../components/PhotoGrid';
import { PHOTO_ERROR_MESSAGES } from '../errors';
import { useTripPhotos } from '../hooks/useTripPhotos';

/**
 * Owns presentation only. Paging, reconciliation and the 404 split live in
 * `useTripPhotos`; batching and upload live in the upload session.
 */
export function PhotosScreen() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const {
    photos,
    status,
    error,
    errorSource,
    refreshing,
    loadingMore,
    hasNextPage,
    tripNotFound,
    loadFirstPage,
    loadMore,
    handleAssetNotFound,
  } = useTripPhotos(tripId);

  const retryInitial = useCallback(() => {
    void loadFirstPage('initial');
  }, [loadFirstPage]);

  const refresh = useCallback(() => {
    void loadFirstPage('refresh');
  }, [loadFirstPage]);

  const handleEndReached = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  const handlePhotoPress = useCallback(() => {
    // The full-screen viewer arrives with sub-issue 3.4.
  }, []);

  if (tripNotFound) {
    // Neutral on purpose: a trip that was deleted and a trip the user was
    // removed from must be indistinguishable.
    return (
      <Screen>
        <View style={styles.centered} testID="photos-trip-not-found">
          <Text style={styles.emptyTitle}>{PHOTO_ERROR_MESSAGES.tripNotFound}</Text>
        </View>
      </Screen>
    );
  }

  if (status === 'loading' && photos.length === 0) {
    return <LoadingScreen />;
  }

  if (status === 'error' && photos.length === 0) {
    return (
      <Screen>
        <View style={styles.centered} testID="photos-initial-error">
          <Text style={styles.emptyBody}>{error?.message ?? PHOTO_ERROR_MESSAGES.tripNotFound}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading photos"
            onPress={retryInitial}
            style={styles.action}
          >
            <Text style={styles.actionText}>Retry</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  if (photos.length === 0) {
    return (
      <Screen>
        <View style={styles.centered} testID="photos-empty">
          <Text style={styles.emptyTitle}>No photos yet</Text>
          <Text style={styles.emptyBody}>Photos added to this trip will show up here.</Text>
        </View>
      </Screen>
    );
  }

  // A failure that arrived while photos are on screen must never replace them.
  const inlineError = errorSource === 'refresh' || errorSource === 'background' ? error : null;
  const pageError = errorSource === 'loadMore' ? error : null;

  return (
    <Screen edges={['bottom']}>
      <View style={styles.fill}>
        {inlineError ? (
          <View style={styles.banner} testID="photos-inline-error">
            <Text style={styles.bannerText}>{inlineError.message}</Text>
          </View>
        ) : null}
        <PhotoGrid
          tripId={tripId}
          photos={photos}
          refreshing={refreshing}
          loadingMore={loadingMore}
          hasNextPage={hasNextPage}
          pageError={pageError}
          onRefresh={refresh}
          onEndReached={handleEndReached}
          onRetryPage={handleEndReached}
          onPhotoPress={handlePhotoPress}
          onAssetNotFound={handleAssetNotFound}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, marginHorizontal: -spacing.lg },
  centered: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.sm,
    justifyContent: 'center',
  },
  emptyTitle: { ...typography.heading, color: colors.text },
  emptyBody: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  action: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  actionText: { ...typography.label, color: colors.primary },
  banner: {
    backgroundColor: colors.warningSoft,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    borderRadius: 10,
  },
  bannerText: { ...typography.caption, color: colors.warning },
});
