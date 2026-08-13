import { AccessibilityInfo, type HostInstance } from 'react-native';

export type AccessibilityFocusTarget = HostInstance | null;

export interface AccessibilityFocusDependencies {
  readonly sendAccessibilityEvent: (
    node: HostInstance,
    eventType: 'focus',
  ) => void;
}

const DEFAULT_ACCESSIBILITY_FOCUS_DEPENDENCIES: AccessibilityFocusDependencies = {
  sendAccessibilityEvent: (node, eventType) =>
    AccessibilityInfo.sendAccessibilityEvent(node, eventType),
};

export function focusAccessibilityNode(
  node: AccessibilityFocusTarget,
  dependencies: AccessibilityFocusDependencies =
    DEFAULT_ACCESSIBILITY_FOCUS_DEPENDENCIES,
): boolean {
  if (node === null) {
    return false;
  }
  dependencies.sendAccessibilityEvent(node, 'focus');
  return true;
}
