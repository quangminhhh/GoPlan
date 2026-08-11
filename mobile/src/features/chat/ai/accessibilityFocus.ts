import { AccessibilityInfo, findNodeHandle } from 'react-native';

export type AccessibilityFocusTarget = Parameters<typeof findNodeHandle>[0];

export interface AccessibilityFocusDependencies {
  readonly findNodeHandle: (
    node: AccessibilityFocusTarget,
  ) => number | null;
  readonly setAccessibilityFocus: (handle: number) => void;
}

const DEFAULT_ACCESSIBILITY_FOCUS_DEPENDENCIES: AccessibilityFocusDependencies = {
  findNodeHandle: (node) => findNodeHandle(node),
  setAccessibilityFocus: (handle) =>
    AccessibilityInfo.setAccessibilityFocus(handle),
};

export function focusAccessibilityNode(
  node: AccessibilityFocusTarget,
  dependencies: AccessibilityFocusDependencies =
    DEFAULT_ACCESSIBILITY_FOCUS_DEPENDENCIES,
): boolean {
  if (node === null) {
    return false;
  }
  const handle = dependencies.findNodeHandle(node);
  if (handle === null) {
    return false;
  }
  dependencies.setAccessibilityFocus(handle);
  return true;
}
