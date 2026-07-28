const mockIonicons = jest.fn((_props: unknown) => null);

jest.mock('@expo/vector-icons', () => ({
  Ionicons: (props: unknown) => mockIonicons(props),
}));

// eslint-disable-next-line import/first
import {
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { ExpenseRow } from '../components/ExpenseRow';
// eslint-disable-next-line import/first
import { ExpenseSummaryStrip } from '../components/ExpenseSummaryStrip';
// eslint-disable-next-line import/first
import { MemberBalanceRow } from '../components/MemberBalanceRow';
// eslint-disable-next-line import/first
import type { ExpenseListItem } from '../types';

function buildExpense(
  overrides: Partial<ExpenseListItem> = {},
): ExpenseListItem {
  return {
    id: 'expense-1',
    title: 'Beach house',
    description: 'Three nights by the sea',
    total_amount: '300.00',
    paid_amount: '250.00',
    missing_amount: '50.00',
    surplus_amount: '0.00',
    currency_code: 'USD',
    status: 'UNDERFUNDED',
    collector: {
      id: 'collector-1',
      display_name: 'Minh',
      identify_tag: 'minh#1234',
    },
    locked: false,
    ...overrides,
  };
}

describe('ExpenseSummaryStrip', () => {
  it('renders only server amounts, the viewer balance, surplus, and progress', async () => {
    await render(
      <ExpenseSummaryStrip
        summary={{
          total_amount: '100.00',
          paid_amount: '75.00',
          missing_amount: '25.00',
          surplus_amount: '5.00',
        }}
        myBalance={{
          balance: '-10.00',
          surplus_held: '2.00',
        }}
        currencyCode="USD"
      />,
    );

    expect(screen.getByText('Total expenses')).toBeTruthy();
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('$75.00')).toBeTruthy();
    expect(screen.getByText('$25.00')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('You owe $10.00')).toBeTruthy();
    expect(screen.getByText('$2.00')).toBeTruthy();
    expect(
      screen.getByLabelText('Collection progress 75 percent').props
        .accessibilityValue,
    ).toEqual({ min: 0, max: 100, now: 75 });
  });

  it('does not show a surplus note for a canonical zero string', async () => {
    await render(
      <ExpenseSummaryStrip
        summary={{
          total_amount: '0.00',
          paid_amount: '0.00',
          missing_amount: '0.00',
          surplus_amount: '0.00',
        }}
        myBalance={{
          balance: '-0.00',
          surplus_held: '0.00',
        }}
        currencyCode="USD"
      />,
    );

    expect(screen.getByText('Settled')).toBeTruthy();
    expect(screen.queryByText(/in group surplus/)).toBeNull();
    expect(
      screen.getByLabelText('Collection progress 0 percent').props
        .accessibilityValue,
    ).toMatchObject({ now: 0 });
  });
});

describe('MemberBalanceRow', () => {
  it('uses the neutral Member fallback and never needs a raw user id', async () => {
    await render(
      <MemberBalanceRow
        memberName={null}
        balance="-18.50"
        currencyCode="USD"
      />,
    );

    expect(screen.getByText('Member')).toBeTruthy();
    expect(screen.getByText('Owes $18.50')).toBeTruthy();
    expect(screen.getByLabelText('Member, Owes $18.50')).toBeTruthy();
  });

  it('renders positive and settled directions without client-derived shares', async () => {
    const rendered = await render(
      <MemberBalanceRow
        memberName="An"
        identifyTag="an#1200"
        balance="12.00"
        currencyCode="USD"
      />,
    );

    expect(screen.getByText('Is owed $12.00')).toBeTruthy();
    await rendered.rerender(
      <MemberBalanceRow
        memberName="An"
        identifyTag="an#1200"
        balance="0.00"
        currencyCode="USD"
      />,
    );
    expect(screen.getByText('Settled')).toBeTruthy();
  });
});

describe('ExpenseRow', () => {
  it('renders status, collector, server amounts, and forwards the stable id', async () => {
    const onPress = jest.fn();
    await render(
      <ExpenseRow expense={buildExpense()} onPress={onPress} />,
    );

    expect(screen.getByText('Beach house')).toBeTruthy();
    expect(screen.getByText('Underfunded')).toBeTruthy();
    expect(screen.getByText('Missing $50.00')).toBeTruthy();
    expect(screen.getByText('$300.00')).toBeTruthy();
    expect(screen.getByText('$250.00')).toBeTruthy();
    expect(screen.getByText('Minh')).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Open expense Beach house, Underfunded, total $300.00, collected $250.00, collector Minh',
      }),
    );
    expect(onPress).toHaveBeenCalledWith('expense-1');
  });

  it('shows locked/overfunded state and blocks disabled presses', async () => {
    const onPress = jest.fn();
    await render(
      <ExpenseRow
        expense={buildExpense({
          status: 'OVERFUNDED',
          surplus_amount: '12.00',
          locked: true,
        })}
        disabled
        onPress={onPress}
      />,
    );

    expect(screen.getByText('Overfunded')).toBeTruthy();
    expect(screen.getByText('Surplus $12.00')).toBeTruthy();
    expect(
      mockIonicons.mock.calls.some(
        ([props]) =>
          (props as { name?: string }).name ===
          'lock-closed-outline',
      ),
    ).toBe(true);
    const row = screen.getByRole('button', {
      name: 'Open expense Beach house, Overfunded, locked, total $300.00, collected $250.00, collector Minh',
    });
    expect(row.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(row);
    expect(onPress).not.toHaveBeenCalled();
  });
});
