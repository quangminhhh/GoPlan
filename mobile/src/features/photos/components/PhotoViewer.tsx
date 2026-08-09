/**
 * Full-screen photo viewer.
 *
 * An in-component overlay rather than a route (D8/§4.1). Two consequences: the
 * trips Stack needs no screen for it, and because it renders inside a React
 * Native `Modal`, the gestures inside need their own `GestureHandlerRootView` —
 * gesture-handler does not inherit the Stack's root across a modal boundary, and
 * when it is missing the gestures simply do nothing, with no error to notice.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  type LayoutChangeEvent,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AuthenticatedImage } from '@/shared/media/AuthenticatedImage';
import type { ProtectedAssetError } from '@/shared/media/protectedAssetTypes';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { tripPhotoAssetKey, tripPhotoAssetKeyPrefix, tripPhotoAssetPath } from '../api';
import { TRIP_PHOTO_VARIANTS } from '../constants';
import { toPhotoFailure, type PhotoFailure } from '../errors';
import type { TripPhoto } from '../types';
import type { ViewerActionState } from '../hooks/usePhotoViewer';
import { PhotoFeedbackToast } from './PhotoFeedbackToast';
import { ZoomablePhoto } from './ZoomablePhoto';

/** Only the current photo and its two neighbours are ever mounted. */
const NEIGHBOUR_WINDOW = 1;
export const DISMISS_TRANSLATION = 120;

export function dismissTranslationForViewport(viewportHeight: number): number {
  'worklet';
  return Math.max(80, Math.min(DISMISS_TRANSLATION, viewportHeight * 0.15));
}

interface SynchronousViewportHost {
  getBoundingClientRect?: () => { width: number; height: number };
}

export function readSynchronousMediaViewport(
  viewport: SynchronousViewportHost | null,
): { width: number; height: number } | null {
  if (!viewport || typeof viewport.getBoundingClientRect !== 'function') {
    return null;
  }
  const { width, height } = viewport.getBoundingClientRect();
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

export function mediaViewportFallback(
  width: number,
  height: number,
  insetTop: number,
  insetBottom: number,
): { width: number; height: number } {
  return {
    width,
    height: Math.max(1, height - insetTop - insetBottom),
  };
}

export function photoViewerPageKey(photoId: string, currentPhotoId: string): string {
  return `${photoId}:${photoId === currentPhotoId ? 'active' : 'neighbour'}`;
}

export function zoomChangeHandlerForPage(
  photoId: string,
  currentPhotoId: string,
  handler: (zoomed: boolean) => void,
): ((zoomed: boolean) => void) | undefined {
  return photoId === currentPhotoId ? handler : undefined;
}

interface PhotoViewerProps {
  tripId: string;
  photos: TripPhoto[];
  currentIndex: number;
  currentPhoto: TripPhoto;
  action: ViewerActionState;
  onClose: () => void;
  onGoToOffset: (offset: number) => void;
  onGoTo: (photoId: string) => void;
  onDelete: () => void;
  onSave: () => void;
  onDismissAction: () => void;
  onAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
  onOpenSettings?: () => void;
}

export function formatCapturedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // A malformed timestamp is not a reason to blank the whole overlay.
    return 'Date unavailable';
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function PhotoViewer({
  tripId,
  photos,
  currentIndex,
  currentPhoto,
  action,
  onClose,
  onGoToOffset,
  onGoTo,
  onDelete,
  onSave,
  onDismissAction,
  onAssetNotFound,
  onOpenSettings = () => {
    void Linking.openSettings();
  },
}: PhotoViewerProps) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [zoomed, setZoomed] = useState(false);
  const [mediaViewport, setMediaViewport] = useState(() =>
    mediaViewportFallback(window.width, window.height, insets.top, insets.bottom),
  );
  const mediaViewportRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pinchInProgress = useSharedValue(false);

  const updateMediaViewport = useCallback((width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    setMediaViewport((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  useLayoutEffect(() => {
    const viewport = mediaViewportRef.current;
    if (!viewport) {
      return;
    }
    // Fabric exposes this synchronously. Reading it in a layout effect gives
    // the pager and zoom math correct safe-area bounds before paint instead of
    // spending one frame at full-window dimensions.
    const synchronous = readSynchronousMediaViewport(viewport);
    if (synchronous) {
      updateMediaViewport(synchronous.width, synchronous.height);
      return;
    }
    // Defensive fallback for a legacy host implementation.
    const fallback = mediaViewportFallback(
      window.width,
      window.height,
      insets.top,
      insets.bottom,
    );
    updateMediaViewport(fallback.width, fallback.height);
    viewport.measure(
      (_x, _y, width, height) => updateMediaViewport(width, height),
    );
  }, [window.width, window.height, insets.top, insets.bottom, updateMediaViewport]);

  useEffect(
    () => () => {
      pinchInProgress.set(false);
    },
    [pinchInProgress],
  );

  const handleMediaLayout = useCallback(
    (event: LayoutChangeEvent) => {
      updateMediaViewport(
        event.nativeEvent.layout.width,
        event.nativeEvent.layout.height,
      );
    },
    [updateMediaViewport],
  );
  // Putting the native ScrollView recognizer into RNGH's relation graph lets
  // child gestures run simultaneously with it: vertical dismiss is no longer
  // swallowed, while ordinary horizontal movement still pages at rest.
  const pagerGesture = useMemo(() => Gesture.Native(), []);
  const dismissGesture = Gesture.Pan()
    .withTestId('photo-viewer-dismiss-gesture')
    .enabled(!zoomed)
    .activeOffsetY([-10, 10])
    .failOffsetX([-24, 24])
    .simultaneousWithExternalGesture(pagerGesture)
    .onEnd((event) => {
      'worklet';
      if (
        !pinchInProgress.get() &&
        event.translationY > dismissTranslationForViewport(mediaViewport.height)
      ) {
        runOnJS(onClose)();
      }
    });
  const pagerGestures = Gesture.Simultaneous(pagerGesture, dismissGesture);

  const visible = useMemo(
    () =>
      photos.filter(
        (_photo, index) =>
          index >= currentIndex - NEIGHBOUR_WINDOW && index <= currentIndex + NEIGHBOUR_WINDOW,
      ),
    [photos, currentIndex],
  );

  const windowIndex = visible.findIndex((item) => item.id === currentPhoto.id);

  // Re-centres the pager whenever the window slides — swiping forward shifts
  // every item one place left, so without this the same photo would appear to
  // jump.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      x: mediaViewport.width * Math.max(0, windowIndex),
      animated: false,
    });
  }, [windowIndex, mediaViewport.width]);

  const pageStyle = useMemo(
    () => ({ width: mediaViewport.width, height: mediaViewport.height }),
    [mediaViewport.height, mediaViewport.width],
  );

  const handleNotFound = useCallback(
    (photoId: string) => (error: ProtectedAssetError) => onAssetNotFound(photoId, toPhotoFailure(error)),
    [onAssetNotFound],
  );

  const confirmDelete = useCallback(() => {
    Alert.alert('Delete photo?', 'This photo will be removed for everyone. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  }, [onDelete]);

  const busy = action.status === 'deleting' || action.status === 'saving';
  const atStart = currentIndex <= 0;
  const atEnd = currentIndex >= photos.length - 1;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.root} testID="photo-viewer">
          <View
            ref={mediaViewportRef}
            onLayout={handleMediaLayout}
            style={[
              styles.mediaViewport,
              { marginTop: insets.top, marginBottom: insets.bottom },
            ]}
            testID="photo-viewer-media-viewport"
          >
            <GestureDetector gesture={pagerGestures}>
              <ScrollView
                ref={scrollRef}
                testID="photo-viewer-pager"
                horizontal
                pagingEnabled
                // A zoomed photo owns its own horizontal drags; letting the pager
                // keep them would make panning switch photos instead.
                scrollEnabled={!zoomed}
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(event) => {
                  if (pinchInProgress.get()) {
                    return;
                  }
                  const page = Math.round(
                    event.nativeEvent.contentOffset.x / mediaViewport.width,
                  );
                  const next = visible[page];
                  if (next && next.id !== currentPhoto.id) {
                    onGoTo(next.id);
                  }
                }}
              >
                {/* A plain ScrollView rather than a virtualised list: the window is
                    already capped at three items, and FlatList would leave the
                    previous neighbour unrendered until it is scrolled into view. */}
                {visible.map((item) => {
                  const isCurrent = item.id === currentPhoto.id;
                  return (
                    <View
                      // Neighbours are pre-mounted. Remount both pages when the active
                      // id changes so zoom/pan state owned by the old active page
                      // cannot leave the new page's pager disabled.
                      key={photoViewerPageKey(item.id, currentPhoto.id)}
                      accessibilityElementsHidden={!isCurrent}
                      importantForAccessibility={isCurrent ? 'auto' : 'no-hide-descendants'}
                      style={pageStyle}
                      testID={`photo-viewer-page-${item.id}`}
                    >
                      <ZoomablePhoto
                        photoId={item.id}
                        width={mediaViewport.width}
                        height={mediaViewport.height}
                        sourceWidth={item.medium_width}
                        sourceHeight={item.medium_height}
                        zoomed={zoomed && isCurrent}
                        pagerGesture={pagerGesture}
                        dismissGesture={dismissGesture}
                        pinchInProgress={pinchInProgress}
                        onZoomChange={zoomChangeHandlerForPage(
                          item.id,
                          currentPhoto.id,
                          setZoomed,
                        )}
                      >
                        <AuthenticatedImage
                          assetKey={tripPhotoAssetKey(tripId, item.id, 'medium')}
                          invalidationPrefix={tripPhotoAssetKeyPrefix(tripId)}
                          path={tripPhotoAssetPath(tripId, item.id, 'medium')}
                          variant={TRIP_PHOTO_VARIANTS.medium}
                          width={mediaViewport.width}
                          height={mediaViewport.height}
                          contentFit="contain"
                          backgroundColor={colors.viewerBackground}
                          accessibilityLabel={`Photo uploaded by ${item.uploaded_by.display_name}`}
                          accessible={isCurrent}
                          sourceWidth={item.medium_width}
                          sourceHeight={item.medium_height}
                          onNotFound={handleNotFound(item.id)}
                        />
                      </ZoomablePhoto>
                    </View>
                  );
                })}
              </ScrollView>
            </GestureDetector>
          </View>

          <View
            style={[styles.topBar, { top: insets.top }]}
            pointerEvents="box-none"
            testID="photo-viewer-top-bar"
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close photo"
              onPress={onClose}
              style={styles.iconButton}
            >
              <Ionicons name="close" size={24} color={colors.background} />
            </Pressable>
            <Text
              accessibilityLiveRegion="polite"
              style={styles.pageLabel}
              testID="photo-viewer-position"
            >
              {`Photo ${currentIndex + 1} of ${photos.length}`}
            </Text>
          </View>

          <View
            style={[styles.bottomStack, { bottom: insets.bottom }]}
            pointerEvents="box-none"
            testID="photo-viewer-bottom-stack"
          >
            {action.status === 'message' ||
            action.status === 'error' ||
            action.status === 'permissionDenied' ? (
              <PhotoFeedbackToast
                message={
                  action.status === 'message'
                    ? action.message
                    : action.status === 'error'
                      ? action.failure.message
                      : action.canAskAgain
                        ? 'GoPlan needs permission to add photos to your library.'
                        : 'Allow photo access for GoPlan in Settings to save photos.'
                }
                onDismiss={onDismissAction}
                {...(action.status === 'permissionDenied' && !action.canAskAgain
                  ? { actionLabel: 'Open Settings', onAction: onOpenSettings }
                  : {})}
                style={styles.toastPlacement}
                testID="photo-viewer-toast"
              />
            ) : null}

            <View
              style={styles.bottomBar}
              pointerEvents="box-none"
              testID="photo-viewer-bottom-bar"
            >
            <View style={styles.metadata}>
              <Text style={styles.uploader}>
                {currentPhoto.uploaded_by.display_name}
                {currentPhoto.uploaded_by.identify_tag
                  ? ` @${currentPhoto.uploaded_by.identify_tag}`
                  : ''}
              </Text>
              <Text style={styles.captured}>{formatCapturedAt(currentPhoto.created_at)}</Text>
            </View>

            <View style={styles.actions}>
              {/* Explicit controls so VoiceOver never depends on a swipe. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Previous photo"
                accessibilityState={{ disabled: atStart }}
                disabled={atStart}
                onPress={() => onGoToOffset(-1)}
                style={styles.iconButton}
              >
                <Ionicons
                  name="chevron-back"
                  size={22}
                  color={atStart ? colors.textMuted : colors.background}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Next photo"
                accessibilityState={{ disabled: atEnd }}
                disabled={atEnd}
                onPress={() => onGoToOffset(1)}
                style={styles.iconButton}
              >
                <Ionicons
                  name="chevron-forward"
                  size={22}
                  color={atEnd ? colors.textMuted : colors.background}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                // Neutral wording: the download variant is the stored `medium`
                // WebP, not an original, so nothing here promises full quality.
                accessibilityLabel="Save to Photos"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={onSave}
                style={styles.iconButton}
              >
                <Ionicons name="download-outline" size={22} color={colors.background} />
              </Pressable>
              {/* Rendered only on the server's say-so; never re-derived here. */}
              {currentPhoto.can_delete ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Delete photo"
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  onPress={confirmDelete}
                  style={styles.iconButton}
                  testID="photo-viewer-delete"
                >
                  <Ionicons name="trash-outline" size={22} color={colors.danger} />
                </Pressable>
              ) : null}
            </View>
            </View>
          </View>

          {busy ? (
            <View style={styles.overlay} testID="photo-viewer-busy">
              <ActivityIndicator color={colors.background} />
            </View>
          ) : null}

        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.viewerBackground, flex: 1 },
  mediaViewport: { flex: 1 },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    left: 0,
    paddingHorizontal: spacing.md,
    position: 'absolute',
    right: 0,
  },
  bottomStack: {
    gap: spacing.sm,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  bottomBar: {
    flexShrink: 0,
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  metadata: { gap: spacing.xxs },
  uploader: { ...typography.label, color: colors.background },
  captured: { ...typography.caption, color: colors.border },
  pageLabel: { ...typography.caption, color: colors.background },
  actions: { flexDirection: 'row', gap: spacing.sm },
  // 44x44 is the minimum comfortable touch target on iOS.
  iconButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  overlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    alignItems: 'center',
    backgroundColor: colors.mediaBusyOverlay,
    justifyContent: 'center',
  },
  toastPlacement: {
    flexShrink: 0,
    marginHorizontal: spacing.lg,
  },
});
