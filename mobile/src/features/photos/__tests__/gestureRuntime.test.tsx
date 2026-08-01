/**
 * Guards the Jest setup that makes worklet-backed components importable.
 *
 * Before this feature, react-native-gesture-handler and react-native-reanimated
 * were in package.json with zero usages in `src/`, and neither worked under
 * Jest: Reanimated 4 initialises a worklets native module at import time, and
 * the repo had also dropped jest-expo's own `transformIgnorePatterns`
 * exclusions. Three things fixed that — RNGH's shipped `jestSetup.js`, the
 * Reanimated stand-in in `test/reanimatedMock.tsx`, and restoring those
 * exclusions.
 *
 * Kept as its own test so a regression fails here, with a name that says what
 * broke, rather than as a confusing import error inside a viewer test.
 */
import { render, screen } from '@testing-library/react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

function PinchProbe() {
  'use no memo';

  const scale = useSharedValue(1);
  const pinch = Gesture.Pinch().onUpdate((event) => {
    scale.set(event.scale);
  });
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <GestureHandlerRootView>
      <GestureDetector gesture={pinch}>
        <Animated.View testID="pinch-probe" style={style} />
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

it('imports and renders a worklet-backed component under jest', async () => {
  await render(<PinchProbe />);

  expect(screen.getByTestId('pinch-probe')).toBeTruthy();
});
