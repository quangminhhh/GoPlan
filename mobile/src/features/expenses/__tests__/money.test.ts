import {
  formatExpenseMoney,
  getExpenseCurrencyScale,
  getExpenseFundingPercent,
  getExpenseStatusLabel,
  getExpenseStatusTone,
  getSettlementTransferRoleState,
  getUserBalanceDirection,
  getUserBalanceLabel,
  normalizeExpenseMoneyInput,
  parseMoneyAmount,
  ZERO_DECIMAL_CURRENCIES,
} from '../money';
import type { SettlementTransfer } from '../types';

function buildTransfer(
  overrides: Partial<SettlementTransfer> = {},
): SettlementTransfer {
  return {
    id: 'transfer-1',
    payer: {
      id: 'payer-1',
      display_name: 'Payer',
      identify_tag: '@payer',
    },
    recipient: {
      id: 'recipient-1',
      display_name: 'Recipient',
      identify_tag: '@recipient',
    },
    amount: '100.00',
    payer_marked_sent_at: null,
    recipient_confirmed_at: null,
    ...overrides,
  };
}

describe('expense money formatting', () => {
  it('uses the backend zero-decimal currency set', () => {
    expect([...ZERO_DECIMAL_CURRENCIES]).toEqual(['VND', 'JPY', 'KRW']);
    expect(getExpenseCurrencyScale('vnd')).toBe(0);
    expect(getExpenseCurrencyScale('JPY')).toBe(0);
    expect(getExpenseCurrencyScale('krw')).toBe(0);
    expect(getExpenseCurrencyScale('USD')).toBe(2);
  });

  it('formats zero-decimal and two-decimal amounts for display only', () => {
    const vnd = formatExpenseMoney('50000', 'VND');
    const usd = formatExpenseMoney('10.50', 'USD');

    expect(vnd).toContain('50');
    expect(vnd).not.toMatch(/[.,]00(?:\D|$)/);
    expect(usd).toContain('10.50');
  });

  it('falls back safely for an unknown or malformed currency code', () => {
    expect(formatExpenseMoney('10', 'NOT-A-CURRENCY')).toBe(
      '10 NOT-A-CURRENCY',
    );
  });

  it('parses only for display helpers and degrades invalid values to zero', () => {
    expect(parseMoneyAmount('12.50')).toBe(12.5);
    expect(parseMoneyAmount(12.5)).toBe(12.5);
    expect(parseMoneyAmount('not-money')).toBe(0);
  });
});

describe('canonical expense input', () => {
  it.each([
    ['1500000', '1500000'],
    ['1.500.000', '1500000'],
    ['1,500,000', '1500000'],
    ['1 500 000', '1500000'],
    ['0001500', '1500'],
  ])('normalizes VND %s without Number conversion', (input, expected) => {
    expect(normalizeExpenseMoneyInput(input, 'VND')).toEqual({
      value: expected,
      error: null,
    });
  });

  it.each(['1500.50', '1,50', '1..500', '-1', '1e3'])(
    'rejects invalid zero-decimal input %s',
    (input) => {
      expect(normalizeExpenseMoneyInput(input, 'VND').value).toBeNull();
    },
  );

  it.each([
    ['1500', '1500'],
    ['1,500.50', '1500.50'],
    ['001500.50', '1500.50'],
    ['0.01', '0.01'],
  ])('normalizes USD %s as a canonical decimal string', (input, expected) => {
    expect(normalizeExpenseMoneyInput(input, 'USD')).toEqual({
      value: expected,
      error: null,
    });
  });

  it.each(['10.555', '1.500,50', '.50', '-1.00', '1e3'])(
    'rejects invalid two-decimal input %s',
    (input) => {
      expect(normalizeExpenseMoneyInput(input, 'USD').value).toBeNull();
    },
  );

  it('mirrors DRF max_digits=14 and decimal_places=2 boundaries', () => {
    expect(
      normalizeExpenseMoneyInput('999999999999', 'VND'),
    ).toEqual({
      value: '999999999999',
      error: null,
    });
    expect(
      normalizeExpenseMoneyInput('9999999999999', 'VND').value,
    ).toBeNull();

    expect(
      normalizeExpenseMoneyInput('999999999999.99', 'USD'),
    ).toEqual({
      value: '999999999999.99',
      error: null,
    });
    expect(
      normalizeExpenseMoneyInput('9999999999999.9', 'USD').value,
    ).toBeNull();
  });

  it('requires positive totals while retaining zero as a valid contribution', () => {
    expect(
      normalizeExpenseMoneyInput('0', 'VND', {
        minimum: 'positive',
      }),
    ).toEqual({
      value: null,
      error: 'Amount must be greater than zero.',
    });
    expect(
      normalizeExpenseMoneyInput('0', 'VND', {
        minimum: 'non-negative',
      }),
    ).toEqual({ value: '0', error: null });
  });

  it('does not impose a client-side overfunding ceiling', () => {
    expect(
      normalizeExpenseMoneyInput('999999999999.99', 'USD', {
        minimum: 'non-negative',
      }).value,
    ).toBe('999999999999.99');
  });
});

describe('expense display state helpers', () => {
  it('clamps funding percentages and handles invalid totals', () => {
    expect(
      getExpenseFundingPercent({
        total_amount: '100.00',
        paid_amount: '25.00',
      }),
    ).toBe(25);
    expect(
      getExpenseFundingPercent({
        total_amount: '100.00',
        paid_amount: '150.00',
      }),
    ).toBe(100);
    expect(
      getExpenseFundingPercent({
        total_amount: '0',
        paid_amount: '50.00',
      }),
    ).toBe(0);
  });

  it('labels balance direction without deriving business money', () => {
    expect(getUserBalanceDirection('-10.00')).toBe('owe');
    expect(getUserBalanceDirection('10.00')).toBe('receive');
    expect(getUserBalanceDirection('0.00')).toBe('balanced');
    expect(getUserBalanceLabel('-10.00', 'USD')).toContain('You owe');
    expect(getUserBalanceLabel('10.00', 'USD')).toContain('You are owed');
    expect(getUserBalanceLabel('0.00', 'USD')).toBe('Settled');
  });

  it.each([
    ['UNDERFUNDED', 'Underfunded', 'warning'],
    ['FUNDED', 'Funded', 'success'],
    ['OVERFUNDED', 'Overfunded', 'danger'],
  ] as const)('maps %s to its label and tone', (status, label, tone) => {
    expect(getExpenseStatusLabel(status)).toBe(label);
    expect(getExpenseStatusTone(status)).toBe(tone);
  });
});

describe('settlement transfer role state', () => {
  it('allows only the payer to mark an unsent transfer', () => {
    expect(
      getSettlementTransferRoleState(buildTransfer(), 'payer-1'),
    ).toEqual({
      isPayer: true,
      isRecipient: false,
      isSent: false,
      isReceived: false,
      canMarkSent: true,
      canConfirmReceived: false,
      actionLabel: 'I sent it',
    });
  });

  it('allows only the recipient to confirm after sent and before received', () => {
    const transfer = buildTransfer({
      payer_marked_sent_at: '2026-07-28T00:00:00Z',
    });

    expect(
      getSettlementTransferRoleState(transfer, 'recipient-1'),
    ).toMatchObject({
      isRecipient: true,
      isSent: true,
      isReceived: false,
      canMarkSent: false,
      canConfirmReceived: true,
      actionLabel: 'I received it',
    });
    expect(
      getSettlementTransferRoleState(transfer, 'payer-1'),
    ).toMatchObject({
      canMarkSent: false,
      canConfirmReceived: false,
      actionLabel: null,
    });
  });

  it('makes received transfers tracking-only and idempotent in the UI', () => {
    const transfer = buildTransfer({
      payer_marked_sent_at: '2026-07-28T00:00:00Z',
      recipient_confirmed_at: '2026-07-28T01:00:00Z',
    });

    expect(
      getSettlementTransferRoleState(transfer, 'recipient-1'),
    ).toMatchObject({
      isReceived: true,
      canMarkSent: false,
      canConfirmReceived: false,
      actionLabel: null,
    });
  });

  it.each([null, 'unrelated-1'])(
    'returns tracking-only state for nullable or unrelated viewer %s',
    (viewerId) => {
      expect(
        getSettlementTransferRoleState(buildTransfer(), viewerId),
      ).toEqual({
        isPayer: false,
        isRecipient: false,
        isSent: false,
        isReceived: false,
        canMarkSent: false,
        canConfirmReceived: false,
        actionLabel: null,
      });
    },
  );
});
