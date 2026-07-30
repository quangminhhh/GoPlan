/**
 * Pinch, pan, double-tap and swipe-down for one photo.
 *
 * Gesture precedence is the whole design. Horizontal panning belongs to the
 * pager only while the photo is unzoomed; once it is zoomed, the same drag has
 * to move the image instead. Swipe-to-dismiss is likewise only available at rest
 * — otherwise every downward drag on a zoomed photo would close the viewer.
 */

import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2;
/** How far a downward drag has to travel before it counts as a dismiss. */
export const DISMISS_TRANSLATION = 120;

interface ZoomablePhotoProps {
  /** Resetting shared values keys off this, not off array position. */
  photoId: string;
  width: number;
  height: number;
  onDismiss: () => void;
  /** Reported so the pager can stop competing for horizontal drags. */
  onZoomChange?: (zoomed: boolean) => void;
  children: React.ReactNode;
}

export function ZoomablePhoto({
  photoId,
  width,
  height,
  onDismiss,
  onZoomChange,
  children,
}: ZoomablePhotoProps) {
  // Opted out of the React Compiler on purpose. A Reanimated shared value is
  // mutable by design and lives on the UI thread, which the compiler reads as
  // "this value cannot be modified" — the memoisation it would add has nothing
  // to memoise here, since none of this state goes through React renders.
  'use no memo';

  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();

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
  }, [onZoomChange]);

  const reportZoom = (zoomed: boolean): void => {
    onZoomChange?.(zoomed);
  };

  const clamp = (value: number, min: number, max: number): number => {
    'worklet';
    return Math.min(Math.max(value, min), max);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      'worklet';
      scale.value = clamp(savedScale.value * event.scale, MIN_ZOOM, MAX_ZOOM);
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      if (scale.value <= MIN_ZOOM) {
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
      runOnJS(reportZoom)(scale.value > MIN_ZOOM);
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      'worklet';
      if (scale.value > MIN_ZOOM) {
        // Clamped to the scaled image's own bounds, so a zoomed photo cannot be
        // dragged off screen.
        const maxX = Math.max(0, (width * scale.value - viewportWidth) / 2);
        const maxY = Math.max(0, (height * scale.value - viewportHeight) / 2);
        translateX.value = clamp(savedTranslateX.value + event.translationX, -maxX, maxX);
        translateY.value = clamp(savedTranslateY.value + event.translationY, -maxY, maxY);
        return;
      }
      // At rest, only a mostly-vertical drag is ours; anything else belongs to
      // the pager.
      if (Math.abs(event.translationY) > Math.abs(event.translationX)) {
        translateY.value = event.translationY;
      }
    })
    .onEnd(() => {
      'worklet';
      if (scale.value > MIN_ZOOM) {
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        return;
      }
      if (translateY.value > DISMISS_TRANSLATION) {
        runOnJS(onDismiss)();
        return;
      }
      translateY.value = withTiming(0);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      const zoomedIn = scale.value > MIN_ZOOM;
      const next = zoomedIn ? MIN_ZOOM : DOUBLE_TAP_ZOOM;
      scale.value = withTiming(next);
      savedScale.value = next;
      if (!zoomedIn) {
        runOnJS(reportZoom)(true);
        return;
      }
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
      runOnJS(reportZoom)(false);
    });

  const composed = Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, pan));

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
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
