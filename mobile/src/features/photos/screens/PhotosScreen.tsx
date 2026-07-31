import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { LoadingScreen } from '@/shared/ui/LoadingScreen';
import { Screen } from '@/shared/ui/Screen';
import { PhotoGrid } from '../components/PhotoGrid';
import { PhotoSelectionBar } from '../components/PhotoSelectionBar';
import { PhotoUploadSheet } from '../components/PhotoUploadSheet';
import { PhotoViewer } from '../components/PhotoViewer';
import { PHOTO_ERROR_MESSAGES, type PhotoFailure } from '../errors';
import { usePhotoSelection } from '../hooks/usePhotoSelection';
import { usePhotoUpload } from '../hooks/usePhotoUpload';
import { usePhotoViewer } from '../hooks/usePhotoViewer';
import { useTripPhotos } from '../hooks/useTripPhotos';

/**
 * Owns presentation only. Paging, reconciliation and the 404 split live in
 * `useTripPhotos`; batching and upload live in the upload session.
 */
export function PhotosScreen() {
  const [selectionBarHeight, setSelectionBarHeight] = useState(0);
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

  const handleTripNotFound = useCallback(
    (failure?: PhotoFailure) => {
      handleAssetNotFound(
        '',
        failure ?? {
          kind: 'notFound',
          message: PHOTO_ERROR_MESSAGES.tripNotFound,
          status: 404,
          errorCode: 'TRIP_NOT_FOUND',
        },
      );
    },
    [handleAssetNotFound],
  );

  const {
    snapshot: uploadSnapshot,
    picking: uploadPicking,
    pickFailure: uploadPickFailure,
    pick: pickPhotos,
    dismissPickFailure,
    start: startUpload,
    stop: stopUpload,
    close: closeUploadSession,
  } = usePhotoUpload({
    tripId,
    onUploaded: prependUploaded,
    onReconcile: () => {
      void reconcile();
    },
    onTripNotFound: handleTripNotFound,
  });

  const startPicking = useCallback(() => {
    void pickPhotos();
  }, [pickPhotos]);

  const closeUpload = useCallback(() => {
    void closeUploadSession();
  }, [closeUploadSession]);

  const retryInitial = useCallback(() => {
    void loadFirstPage('initial');
  }, [loadFirstPage]);

  const refresh = useCallback(() => {
    void loadFirstPage('refresh');
  }, [loadFirstPage]);

  const handleEndReached = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  const {
    currentIndex,
    currentPhoto,
    action: viewerAction,
    open: openViewer,
    close: closeViewer,
    goTo: goToPhoto,
    goToOffset,
    confirmDelete,
    save: savePhoto,
    dismissAction: dismissViewerAction,
  } = usePhotoViewer({
    tripId,
    photos,
    hasNextPage,
    loadMore: handleEndReached,
    reconcile,
    removePhoto,
    onAssetNotFound: handleAssetNotFound,
  });

  const handleDelete = useCallback(() => {
    void confirmDelete();
  }, [confirmDelete]);

  const handleSave = useCallback(() => {
    void savePhoto();
  }, [savePhoto]);

  const {
    selectionMode,
    selectedCount,
    download: selectionDownload,
    enterSelection,
    toggle: toggleSelection,
    isSelected,
    selectLoaded,
    clear: clearSelection,
    exit: exitSelection,
    startDownload,
    cancelDownload,
    dismissMessage: dismissSelectionMessage,
  } = usePhotoSelection({
    tripId,
    photos,
    reconcile,
    onTripNotFound: handleTripNotFound,
  });

  // A long press enters selection mode rather than opening the photo, and a tap
  // toggles only while selection mode is on.
  const handleTilePress = useCallback(
    (photoId: string) => {
      if (selectionMode) {
        toggleSelection(photoId);
        return;
      }
      openViewer(photoId);
    },
    [selectionMode, toggleSelection, openViewer],
  );

  const handleStartDownload = useCallback(() => {
    void startDownload();
  }, [startDownload]);

  const detachedFeedback = useMemo(() => {
    if (uploadPickFailure) {
      return {
        message: uploadPickFailure.message,
        dismiss: dismissPickFailure,
      };
    }
    if (
      !currentPhoto &&
      (viewerAction.status === 'message' || viewerAction.status === 'error')
    ) {
      return {
        message:
          viewerAction.status === 'message'
            ? viewerAction.message
            : viewerAction.failure.message,
        dismiss: dismissViewerAction,
      };
    }
    if (
      !selectionMode &&
      (selectionDownload.status === 'message' || selectionDownload.status === 'error')
    ) {
      return {
        message:
          selectionDownload.status === 'message'
            ? selectionDownload.message
            : selectionDownload.failure.message,
        dismiss: dismissSelectionMessage,
      };
    }
    return null;
  }, [
    uploadPickFailure,
    dismissPickFailure,
    currentPhoto,
    viewerAction,
    dismissViewerAction,
    selectionMode,
    selectionDownload,
    dismissSelectionMessage,
  ]);

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
      disabled={uploadPicking}
      onPress={startPicking}
      style={styles.action}
    >
      <Text style={styles.actionText}>Upload</Text>
    </Pressable>
  );

  const uploadSheet = uploadSnapshot ? (
    <PhotoUploadSheet
      snapshot={uploadSnapshot}
      onStart={startUpload}
      onStop={stopUpload}
      onClose={closeUpload}
    />
  ) : null;

  // A failure that arrived while usable list state exists must never replace it.
  // This includes a successfully loaded empty gallery: keep pull-to-refresh and
  // show the non-destructive banner instead of hiding the failure behind copy.
  const inlineError = errorSource === 'refresh' || errorSource === 'background' ? error : null;
  const pageError = errorSource === 'loadMore' ? error : null;

  if (photos.length === 0) {
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
            loadingMore={false}
            hasNextPage={false}
            pageError={null}
            onRefresh={refresh}
            onEndReached={handleEndReached}
            onRetryPage={handleEndReached}
            onPhotoPress={handleTilePress}
            onPhotoLongPress={enterSelection}
            onAssetNotFound={handleAssetNotFound}
            ListEmptyComponent={
              <View style={styles.emptyList} testID="photos-empty">
                <Text style={styles.emptyTitle}>No photos yet</Text>
                <Text style={styles.emptyBody}>Photos added to this trip will show up here.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Upload photos"
                  disabled={uploadPicking}
                  onPress={startPicking}
                  style={styles.action}
                >
                  <Text style={styles.actionText}>Upload photos</Text>
                </Pressable>
              </View>
            }
          />
        </View>
        {uploadSheet}
        {detachedFeedback ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss message"
            onPress={detachedFeedback.dismiss}
            style={styles.toast}
            testID="photos-feedback-toast"
          >
            <Text style={styles.toastText}>{detachedFeedback.message}</Text>
          </Pressable>
        ) : null}
      </Screen>
    );
  }

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
          onPhotoPress={handleTilePress}
          onPhotoLongPress={enterSelection}
          onAssetNotFound={handleAssetNotFound}
          selectionMode={selectionMode}
          isSelected={isSelected}
          bottomInset={selectionMode ? selectionBarHeight : 0}
        />
        {selectionMode ? (
          <PhotoSelectionBar
            selectedCount={selectedCount}
            hasNextPage={hasNextPage}
            download={selectionDownload}
            onSelectLoaded={selectLoaded}
            onClear={clearSelection}
            onExit={exitSelection}
            onDownload={handleStartDownload}
            onCancelDownload={cancelDownload}
            onHeightChange={setSelectionBarHeight}
          />
        ) : null}
      </View>
      {uploadSheet}
      {currentPhoto && !selectionMode ? (
        <PhotoViewer
          tripId={tripId}
          photos={photos}
          currentIndex={currentIndex}
          currentPhoto={currentPhoto}
          action={viewerAction}
          onClose={closeViewer}
          onGoTo={goToPhoto}
          onGoToOffset={goToOffset}
          onDelete={handleDelete}
          onSave={handleSave}
          onDismissAction={dismissViewerAction}
          onAssetNotFound={handleAssetNotFound}
        />
      ) : null}
      {detachedFeedback ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
          onPress={detachedFeedback.dismiss}
          style={styles.toast}
          testID="photos-feedback-toast"
        >
          <Text style={styles.toastText}>{detachedFeedback.message}</Text>
        </Pressable>
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
  emptyList: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
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
    borderRadius: radii.md,
  },
  bannerText: { ...typography.caption, color: colors.warning },
  toast: {
    backgroundColor: colors.text,
    borderRadius: radii.md,
    bottom: spacing.lg,
    left: spacing.lg,
    padding: spacing.md,
    position: 'absolute',
    right: spacing.lg,
  },
  toastText: { ...typography.caption, color: colors.background, textAlign: 'center' },
});
