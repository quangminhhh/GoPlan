import type { ReactNode } from 'react';

interface MockModifier {
  $type: string;
  [key: string]: unknown;
}

interface MockDatePickerProps {
  testID?: string;
  selection?: Date;
  displayedComponents?: string[];
  onDateChange?: (date: Date) => void;
  modifiers?: MockModifier[];
}

interface MockHostProps {
  children: ReactNode;
  colorScheme?: string;
  matchContents?: boolean;
}

const mockDatePicker = jest.fn((_props: MockDatePickerProps) => null);
const mockHost = jest.fn(({ children }: MockHostProps) => children);

jest.mock('@expo/ui/swift-ui', () => ({
  DatePicker: mockDatePicker,
  Host: mockHost,
}));

// The component must load after the native SwiftUI views are mocked.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TimeField } = require('../components/TimeField') as typeof import('../components/TimeField');

// eslint-disable-next-line import/first
import { act, render, screen } from '@testing-library/react-native';

function latestPickerProps(): MockDatePickerProps {
  const props = mockDatePicker.mock.calls.at(-1)?.[0];
  if (!props) {
    throw new Error('Expected the native DatePicker to render.');
  }
  return props;
}

function expectFixedAnchor(date: Date | undefined, hours: number, minutes: number) {
  expect(date).toBeInstanceOf(Date);
  expect(date?.getFullYear()).toBe(2000);
  expect(date?.getMonth()).toBe(0);
  expect(date?.getDate()).toBe(1);
  expect(date?.getHours()).toBe(hours);
  expect(date?.getMinutes()).toBe(minutes);
  expect(date?.getSeconds()).toBe(0);
  expect(date?.getMilliseconds()).toBe(0);
}

describe('TimeField', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wraps the native time picker with a fixed local-date anchor', async () => {
    await render(<TimeField label="Start time" value="23:59" onChange={jest.fn()} />);

    const picker = latestPickerProps();
    expect(picker.testID).toBe('time-field-picker');
    expect(picker.displayedComponents).toEqual(['hourAndMinute']);
    expectFixedAnchor(picker.selection, 23, 59);
    expect(mockHost.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ colorScheme: 'light', matchContents: true }),
    );
  });

  it.each([
    [new Date(2035, 6, 2, 0, 5, 45, 900), '00:05'],
    [new Date(1995, 11, 31, 23, 59, 10, 100), '23:59'],
  ])('emits only zero-padded local time without carrying the date %#', async (date, expected) => {
    const onChange = jest.fn();
    await render(<TimeField label="Start time" value="12:00" onChange={onChange} />);

    await act(async () => {
      latestPickerProps().onDateChange?.(date);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('updates the anchored native selection from controlled value changes', async () => {
    const { rerender } = await render(
      <TimeField label="End time" value="08:07" onChange={jest.fn()} />,
    );
    expectFixedAnchor(latestPickerProps().selection, 8, 7);

    await rerender(<TimeField label="End time" value="18:42" onChange={jest.fn()} />);
    expectFixedAnchor(latestPickerProps().selection, 18, 42);
  });

  it.each(['', '8:30', '24:00', '12:60', ' 08:30'])(
    'uses a deterministic unset anchor and never self-emits for invalid value %p',
    async (value) => {
      const onChange = jest.fn();
      await render(<TimeField label="Start time" value={value} onChange={onChange} />);

      const picker = latestPickerProps();
      expectFixedAnchor(picker.selection, 0, 0);
      expect(picker.modifiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ $type: 'accessibilityValue', value: 'Not set' }),
        ]),
      );
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it('does not emit duplicate or invalid native values', async () => {
    const onChange = jest.fn();
    await render(<TimeField label="Start time" value="09:30" onChange={onChange} />);
    const onDateChange = latestPickerProps().onDateChange;

    await act(async () => {
      onDateChange?.(new Date(2040, 4, 5, 9, 30));
      onDateChange?.(new Date(Number.NaN));
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('provides native accessibility metadata, disabled state, and an announced error', async () => {
    const onChange = jest.fn();
    await render(
      <TimeField
        label="End time"
        value="17:45"
        onChange={onChange}
        disabled
        error="End time must be after start time."
      />,
    );

    expect(screen.getByText('End time')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('End time must be after start time.');
    expect(latestPickerProps().modifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $type: 'accessibilityLabel', label: 'End time' }),
        expect.objectContaining({ $type: 'accessibilityValue', value: '17:45' }),
        expect.objectContaining({
          $type: 'accessibilityHint',
          hint: 'Time selection is unavailable.',
        }),
        expect.objectContaining({ $type: 'disabled', disabled: true }),
      ]),
    );
    await act(async () => {
      latestPickerProps().onDateChange?.(new Date(2030, 0, 1, 18, 30));
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
