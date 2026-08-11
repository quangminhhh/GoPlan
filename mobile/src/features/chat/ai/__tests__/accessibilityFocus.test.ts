import { focusAccessibilityNode } from '../accessibilityFocus';

describe('AI modal accessibility focus helper', () => {
  it('resolves the native node handle before requesting VoiceOver focus', () => {
    const findNodeHandle = jest.fn(() => 42);
    const setAccessibilityFocus = jest.fn();
    expect(
      focusAccessibilityNode(7, {
        findNodeHandle,
        setAccessibilityFocus,
      }),
    ).toBe(true);
    expect(findNodeHandle).toHaveBeenCalledWith(7);
    expect(setAccessibilityFocus).toHaveBeenCalledWith(42);
  });

  it('does not request focus after the target or native handle unmounts', () => {
    const findNodeHandle = jest.fn(() => null);
    const setAccessibilityFocus = jest.fn();
    const dependencies = { findNodeHandle, setAccessibilityFocus };
    expect(focusAccessibilityNode(null, dependencies)).toBe(false);
    expect(focusAccessibilityNode(7, dependencies)).toBe(false);
    expect(setAccessibilityFocus).not.toHaveBeenCalled();
  });
});
