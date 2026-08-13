import type { HostInstance } from 'react-native';
import { focusAccessibilityNode } from '../accessibilityFocus';

describe('AI modal accessibility focus helper', () => {
  it('requests focus on the mounted host instance', () => {
    const node = {} as HostInstance;
    const sendAccessibilityEvent = jest.fn();
    expect(
      focusAccessibilityNode(node, { sendAccessibilityEvent }),
    ).toBe(true);
    expect(sendAccessibilityEvent).toHaveBeenCalledWith(node, 'focus');
  });

  it('does not request focus after the target unmounts', () => {
    const sendAccessibilityEvent = jest.fn();
    const dependencies = { sendAccessibilityEvent };
    expect(focusAccessibilityNode(null, dependencies)).toBe(false);
    expect(sendAccessibilityEvent).not.toHaveBeenCalled();
  });
});
