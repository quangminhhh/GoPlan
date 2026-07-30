import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { Screen } from '@/shared/ui/Screen';
import { PhotoGrid } from '../components/PhotoGrid';
import { PhotoUploadSheet } from '../components/PhotoUploadSheet';
import { PhotoViewer } from '../components/PhotoViewer';
import { PHOTO_ERROR_MESSAGES } from '../errors';
import { usePhotoUpload } from '../hooks/usePhotoUpload';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
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
    reconcile,
    prependUploaded,
    removePhoto,
    handleAssetNotFound,
  } = useTripPhotos(tripId);

  const handleTripNotFound = useCallback(() => {
    handleAssetNotFound('', {
      kind: 'notFound',
      message: PHOTO_ERROR_MESSAGES.tripNotFound,
      status: 404,
      errorCode: 'TRIP_NOT_FOUND',
    });
  }, [handleAssetNotFound]);

  const upload = usePhotoUpload({
    tripId,
    onUploaded: prependUploaded,
    onReconcile: () => {
      void reconcile();
    },
    onTripNotFound: handleTripNotFound,
  });

  const startPicking = useCallback(() => {
    void upload.pick();
  }, [upload]);

  const closeUpload = useCallback(() => {
    void upload.close();
  }, [upload]);

  const retryInitial = useCallback(() => {
    void loadFirstPage('initial');
  }, [loadFirstPage]);

  const refresh = useCallback(() => {
    void loadFirstPage('refresh');
  }, [loadFirstPage]);

  const handleEndReached = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  const viewer = usePhotoViewer({
    tripId,
    photos,
    hasNextPage,
    loadMore: handleEndReached,
    reconcile,
    removePhoto,
    onAssetNotFound: handleAssetNotFound,
  });

  const handleDelete = useCallback(() => {
    void viewer.confirmDelete();
  }, [viewer]);

  const handleSave = useCallback(() => {
    void viewer.save();
  }, [viewer]);

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

  const uploadAction = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Upload photos"
      disabled={upload.picking}
      onPress={startPicking}
      style={styles.action}
    >
      <Text style={styles.actionText}>Upload</Text>
    </Pressable>
  );

  const uploadSheet = upload.snapshot ? (
    <PhotoUploadSheet
      snapshot={upload.snapshot}
      onStart={upload.start}
      onStop={upload.stop}
      onClose={closeUpload}
    />
  ) : null;

  if (photos.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ headerRight: () => uploadAction }} />
        <View style={styles.centered} testID="photos-empty">
          <Text style={styles.emptyTitle}>No photos yet</Text>
          <Text style={styles.emptyBody}>Photos added to this trip will show up here.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Upload photos"
            disabled={upload.picking}
            onPress={startPicking}
            style={styles.action}
          >
            <Text style={styles.actionText}>Upload photos</Text>
          </Pressable>
        </View>
        {uploadSheet}
      </Screen>
    );
  }

  // A failure that arrived while photos are on screen must never replace them.
  const inlineError = errorSource === 'refresh' || errorSource === 'background' ? error : null;
  const pageError = errorSource === 'loadMore' ? error : null;

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ headerRight: () => uploadAction }} />
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
          onPhotoPress={viewer.open}
          onAssetNotFound={handleAssetNotFound}
        />
      </View>
      {uploadSheet}
      {viewer.currentPhoto ? (
        <PhotoViewer
          tripId={tripId}
          photos={photos}
          currentIndex={viewer.currentIndex}
          currentPhoto={viewer.currentPhoto}
          action={viewer.action}
          onClose={viewer.close}
          onGoTo={viewer.goTo}
          onGoToOffset={viewer.goToOffset}
          onDelete={handleDelete}
          onSave={handleSave}
          onDismissAction={viewer.dismissAction}
          onAssetNotFound={handleAssetNotFound}
        />
      ) : null}
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
