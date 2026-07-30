/**
 * Minimal stand-in for react-native-reanimated under Jest.
 *
 * Reanimated 4 initialises a worklets native module at import time, and under
 * Jest that module is absent: importing it throws while installing its
 * unpackers, before a single test runs. The package's own `react-native-reanimated/mock`
 * does not help, because it re-exports from the real entry point and so trips
 * the same initialisation.
 *
 * What this provides is the surface the photo viewer actually uses, with shared
 * values as plain mutable boxes and animated styles resolved eagerly. Animated
 * values therefore do not move in tests: viewer tests assert paging, index and
 * delete behaviour, and gesture behaviour itself is verified on the simulator.
 */

import { createElement, forwardRef, type ComponentType } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';

interface SharedValue<T> {
  value: T;
}

export function useSharedValue<T>(initial: T): SharedValue<T> {
  return { value: initial };
}

export function useAnimatedStyle(factory: () => object): object {
  return factory();
}

export function useAnimatedRef<T>(): { current: T | null } {
  return { current: null };
}

export function useDerivedValue<T>(factory: () => T): SharedValue<T> {
  return { value: factory() };
}

export function withTiming<T>(value: T, _config?: unknown, callback?: (finished: boolean) => void): T {
  callback?.(true);
  return value;
}

export function withSpring<T>(value: T, _config?: unknown, callback?: (finished: boolean) => void): T {
  callback?.(true);
  return value;
}

export function withDecay<T>(_config: unknown, callback?: (finished: boolean) => void): T {
  callback?.(true);
  return 0 as unknown as T;
}

export function cancelAnimation(): void {}

/**
 * Required by gesture-handler's GestureDetector, which probes for these before
 * deciding whether it can drive gestures on the UI thread.
 */
export function useEvent(
  handler: (event: unknown) => void,
): (event: unknown) => void {
  return handler;
}

export function setGestureState(): void {}

export function useAnimatedReaction(): void {}

export function useAnimatedGestureHandler<T>(handlers: T): T {
  return handlers;
}

export function runOnJS<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return fn;
}

export function runOnUI<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return fn;
}

export function interpolate(
  value: number,
  input: number[],
  output: number[],
): number {
  const first = input[0] ?? 0;
  const last = input[input.length - 1] ?? 1;
  if (value <= first) return output[0] ?? 0;
  if (value >= last) return output[output.length - 1] ?? 0;
  const ratio = (value - first) / (last - first || 1);
  const from = output[0] ?? 0;
  const to = output[output.length - 1] ?? 0;
  return from + (to - from) * ratio;
}

export const Extrapolation = {
  CLAMP: 'clamp',
  EXTEND: 'extend',
  IDENTITY: 'identity',
} as const;

export const Easing = {
  linear: (value: number) => value,
  ease: (value: number) => value,
  out: (fn: (value: number) => number) => fn,
  inOut: (fn: (value: number) => number) => fn,
  quad: (value: number) => value,
  cubic: (value: number) => value,
  bezier: () => (value: number) => value,
};

function animated<P extends object>(Component: ComponentType<P>) {
  const Wrapped = forwardRef<unknown, P>((props, ref) =>
    createElement(Component as ComponentType<object>, { ...props, ref }),
  );
  Wrapped.displayName = `Animated(${Component.displayName ?? Component.name ?? 'Component'})`;
  return Wrapped;
}

const Animated = {
  View: animated(View),
  Text: animated(Text),
  Image: animated(Image),
  ScrollView: animated(ScrollView),
  createAnimatedComponent: animated,
};

export default Animated;
