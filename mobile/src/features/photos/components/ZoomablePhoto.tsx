/**
 * Pinch, pan, double-tap and swipe-down for one photo.
 *
 * Gesture precedence is the whole design. Horizontal panning belongs to the
 * pager only while the photo is unzoomed; once it is zoomed, the same drag has
 * to move the image instead. Swipe-to-dismiss is likewise only available at rest
 * — otherwise every downward drag on a zoomed photo would close the viewer.
 */

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { clampNumber, computeContainedPanBounds } from '../zoomMath';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2;

interface ZoomablePhotoProps {
  /** Resetting shared values keys off this, not off array position. */
  photoId: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** React-side zoom state used to enable the correct one-finger pan. */
  zoomed: boolean;
  /** Native recognizer coordinated with the child gestures. */
  pagerGesture: GestureType;
  dismissGesture: GestureType;
  /** UI-thread lock shared with the pager and dismiss owners. */
  pinchInProgress: SharedValue<boolean>;
  /** Reported so the pager can stop competing for horizontal drags. */
  onZoomChange?: (zoomed: boolean) => void;
  children: React.ReactNode;
}

export function ZoomablePhoto({
  photoId,
  width,
  height,
  sourceWidth,
  sourceHeight,
  zoomed,
  pagerGesture,
  dismissGesture,
  pinchInProgress,
  onZoomChange,
  children,
}: ZoomablePhotoProps) {
  const scale = useSharedValue(MIN_ZOOM);
  const savedScale = useSharedValue(MIN_ZOOM);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Shared values need no reset when the photo changes: the pager keys each
  // item by photo id, so a different photo is a different component instance
  // with its own values. What does need resetting is the parent's idea of
  // whether the visible photo is zoomed, or a swipe away from a zoomed photo
  // would leave the pager disabled.
  useEffect(() => {
    onZoomChange?.(false);
    return () => {
      if (onZoomChange) {
        pinchInProgress.set(false);
      }
    };
  }, [onZoomChange, pinchInProgress]);

  const reportZoom = (zoomed: boolean): void => {
    onZoomChange?.(zoomed);
  };

  useAnimatedReaction(
    () => ({ height, sourceHeight, sourceWidth, width }),
    (dimensions, previousDimensions) => {
      if (
        previousDimensions !== null &&
        dimensions.width === previousDimensions.width &&
        dimensions.height === previousDimensions.height &&
        dimensions.sourceWidth === previousDimensions.sourceWidth &&
        dimensions.sourceHeight === previousDimensions.sourceHeight
      ) {
        return;
      }
      const bounds = computeContainedPanBounds(
        dimensions.width,
        dimensions.height,
        dimensions.sourceWidth,
        dimensions.sourceHeight,
        scale.get(),
      );
      const nextX = clampNumber(translateX.get(), -bounds.x, bounds.x);
      const nextY = clampNumber(translateY.get(), -bounds.y, bounds.y);
      translateX.set(withTiming(nextX));
      translateY.set(withTiming(nextY));
      savedTranslateX.set(nextX);
      savedTranslateY.set(nextY);
    },
    [height, sourceHeight, sourceWidth, width],
  );

  const pinch = Gesture.Pinch()
    .withTestId(`photo-pinch-${photoId}`)
    .blocksExternalGesture(pagerGesture, dismissGesture)
    .onBegin(() => {
      'worklet';
      pinchInProgress.set(true);
    })
    .onUpdate((event) => {
      'worklet';
      scale.set(clampNumber(savedScale.get() * event.scale, MIN_ZOOM, MAX_ZOOM));
    })
    .onEnd(() => {
      'worklet';
      savedScale.set(scale.get());
      const bounds = computeContainedPanBounds(
        width,
        height,
        sourceWidth,
        sourceHeight,
        scale.get(),
      );
      const nextX = clampNumber(translateX.get(), -bounds.x, bounds.x);
      const nextY = clampNumber(translateY.get(), -bounds.y, bounds.y);
      translateX.set(withTiming(nextX));
      translateY.set(withTiming(nextY));
      savedTranslateX.set(nextX);
      savedTranslateY.set(nextY);
      runOnJS(reportZoom)(scale.get() > MIN_ZOOM);
    })
    .onFinalize((_event, success) => {
      'worklet';
      if (!success) {
        // CANCEL/FAIL do not run onEnd. Roll the transient transform back to
        // the last committed gesture so the next double tap/pinch does not
        // inherit a scale React still considers unzoomed.
        const stableScale = savedScale.get();
        scale.set(withTiming(stableScale));
        translateX.set(withTiming(savedTranslateX.get()));
        translateY.set(withTiming(savedTranslateY.get()));
        runOnJS(reportZoom)(stableScale > MIN_ZOOM);
      }
      // Every terminal state releases the parent arbitration lock.
      pinchInProgress.set(false);
    });

  const zoomPan = Gesture.Pan()
    .withTestId(`photo-zoom-pan-${photoId}`)
    .enabled(zoomed)
    .simultaneousWithExternalGesture(pagerGesture)
    .onUpdate((event) => {
      'worklet';
      // Clamped to the scaled image's own bounds, so a zoomed photo cannot be
      // dragged off screen.
      const bounds = computeContainedPanBounds(
        width,
        height,
        sourceWidth,
        sourceHeight,
        scale.get(),
      );
      translateX.set(clampNumber(
        savedTranslateX.get() + event.translationX,
        -bounds.x,
        bounds.x,
      ));
      translateY.set(clampNumber(
        savedTranslateY.get() + event.translationY,
        -bounds.y,
        bounds.y,
      ));
    })
    .onEnd(() => {
      'worklet';
      savedTranslateX.set(translateX.get());
      savedTranslateY.set(translateY.get());
    });

  const doubleTap = Gesture.Tap()
    .withTestId(`photo-double-tap-${photoId}`)
    .numberOfTaps(2)
    .simultaneousWithExternalGesture(pagerGesture)
    .onEnd(() => {
      'worklet';
      const zoomedIn = scale.get() > MIN_ZOOM;
      const next = zoomedIn ? MIN_ZOOM : DOUBLE_TAP_ZOOM;
      scale.set(withTiming(next));
      savedScale.set(next);
      if (!zoomedIn) {
        runOnJS(reportZoom)(true);
        return;
      }
      translateX.set(withTiming(0));
      translateY.set(withTiming(0));
      savedTranslateX.set(0);
      savedTranslateY.set(0);
      runOnJS(reportZoom)(false);
    });

  const composed = Gesture.Simultaneous(
    pinch,
    Gesture.Exclusive(doubleTap, zoomPan),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <View style={styles.container} testID={`zoomable-photo-${photoId}`}>
        {/* Transform and opacity only: animating layout would jank the pager. */}
        <Animated.View style={[styles.content, animatedStyle]}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  content: { alignItems: 'center', justifyContent: 'center' },
});
