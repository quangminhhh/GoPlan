import type {
  ExpenseMoneySummary,
  ExpenseStatus,
  SettlementTransfer,
} from './types';

export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'VND',
  'JPY',
  'KRW',
]);

export const EXPENSE_MAX_DIGITS = 14;
export const EXPENSE_DECIMAL_PLACES = 2;
export const EXPENSE_MAX_WHOLE_DIGITS =
  EXPENSE_MAX_DIGITS - EXPENSE_DECIMAL_PLACES;

const DEFAULT_CURRENCY_CODE = 'VND';

const CURRENCY_LOCALES: Readonly<Record<string, string>> = {
  AUD: 'en-AU',
  CAD: 'en-CA',
  EUR: 'de-DE',
  GBP: 'en-GB',
  JPY: 'ja-JP',
  KRW: 'ko-KR',
  SGD: 'en-SG',
  USD: 'en-US',
  VND: 'vi-VN',
};

export type ExpenseStatusTone = 'warning' | 'success' | 'danger';
export type UserBalanceDirection = 'owe' | 'receive' | 'balanced';
export type ExpenseMoneyMinimum = 'positive' | 'non-negative';

export interface NormalizeExpenseMoneyOptions {
  minimum?: ExpenseMoneyMinimum;
}

export interface NormalizedExpenseMoneyInput {
  value: string | null;
  error: string | null;
}

export interface SettlementTransferRoleState {
  isPayer: boolean;
  isRecipient: boolean;
  isSent: boolean;
  isReceived: boolean;
  canMarkSent: boolean;
  canConfirmReceived: boolean;
  actionLabel: 'I sent it' | 'I received it' | null;
}

type ExpenseFundingAmounts = Pick<
  ExpenseMoneySummary,
  'paid_amount' | 'total_amount'
>;

const EXPENSE_STATUS_LABELS: Readonly<Record<ExpenseStatus, string>> = {
  UNDERFUNDED: 'Underfunded',
  FUNDED: 'Funded',
  OVERFUNDED: 'Overfunded',
};

const EXPENSE_STATUS_TONES: Readonly<
  Record<ExpenseStatus, ExpenseStatusTone>
> = {
  UNDERFUNDED: 'warning',
  FUNDED: 'success',
  OVERFUNDED: 'danger',
};

export function normalizeExpenseCurrencyCode(currencyCode: string): string {
  return currencyCode.trim().toUpperCase() || DEFAULT_CURRENCY_CODE;
}

export function getExpenseCurrencyScale(currencyCode: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(
    normalizeExpenseCurrencyCode(currencyCode),
  )
    ? 0
    : 2;
}

export function parseMoneyAmount(amount: string | number): number {
  const parsed =
    typeof amount === 'number' ? amount : Number.parseFloat(amount);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatExpenseMoney(
  amount: string | number,
  currencyCode: string,
): string {
  const numericAmount = parseMoneyAmount(amount);
  const normalizedCurrencyCode =
    normalizeExpenseCurrencyCode(currencyCode);
  const fractionDigits = getExpenseCurrencyScale(normalizedCurrencyCode);
  const locale = CURRENCY_LOCALES[normalizedCurrencyCode] ?? 'en-US';

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizedCurrencyCode,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(numericAmount);
  } catch {
    const grouped = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: fractionDigits,
    }).format(numericAmount);
    return `${grouped} ${normalizedCurrencyCode}`;
  }
}

export function normalizeExpenseMoneyInput(
  value: string,
  currencyCode: string,
  { minimum = 'non-negative' }: NormalizeExpenseMoneyOptions = {},
): NormalizedExpenseMoneyInput {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return { value: null, error: 'Amount is required.' };
  }

  const scale = getExpenseCurrencyScale(currencyCode);
  const canonicalValue =
    scale === 0
      ? normalizeZeroDecimalInput(trimmedValue)
      : normalizeDecimalInput(trimmedValue);

  if (canonicalValue === null) {
    return { value: null, error: 'Invalid amount.' };
  }

  if (!hasValidDecimalPrecision(canonicalValue, scale)) {
    return {
      value: null,
      error: `Amount must use at most ${EXPENSE_MAX_DIGITS} digits with no more than ${EXPENSE_MAX_WHOLE_DIGITS} before the decimal point.`,
    };
  }

  if (minimum === 'positive' && !hasNonZeroDigit(canonicalValue)) {
    return {
      value: null,
      error: 'Amount must be greater than zero.',
    };
  }

  return { value: canonicalValue, error: null };
}

export function getExpenseFundingPercent(
  amounts: ExpenseFundingAmounts,
): number {
  const paidAmount = parseMoneyAmount(amounts.paid_amount);
  const totalAmount = parseMoneyAmount(amounts.total_amount);
  if (totalAmount <= 0) {
    return 0;
  }
  return clampPercent((paidAmount / totalAmount) * 100);
}

export function getUserBalanceDirection(
  balance: string,
): UserBalanceDirection {
  const numericBalance = parseMoneyAmount(balance);
  if (numericBalance < 0) {
    return 'owe';
  }
  if (numericBalance > 0) {
    return 'receive';
  }
  return 'balanced';
}

export function getUserBalanceLabel(
  balance: string,
  currencyCode: string,
): string {
  const numericBalance = parseMoneyAmount(balance);
  if (numericBalance < 0) {
    return `You owe ${formatExpenseMoney(
      Math.abs(numericBalance),
      currencyCode,
    )}`;
  }
  if (numericBalance > 0) {
    return `You are owed ${formatExpenseMoney(
      numericBalance,
      currencyCode,
    )}`;
  }
  return 'Settled';
}

export function getExpenseStatusLabel(status: ExpenseStatus): string {
  return EXPENSE_STATUS_LABELS[status];
}

export function getExpenseStatusTone(
  status: ExpenseStatus,
): ExpenseStatusTone {
  return EXPENSE_STATUS_TONES[status];
}

export function getSettlementTransferRoleState(
  transfer: SettlementTransfer,
  viewerId: string | null,
): SettlementTransferRoleState {
  const isPayer = viewerId !== null && transfer.payer.id === viewerId;
  const isRecipient =
    viewerId !== null && transfer.recipient.id === viewerId;
  const isSent = transfer.payer_marked_sent_at !== null;
  const isReceived = transfer.recipient_confirmed_at !== null;
  const canMarkSent = isPayer && !isSent;
  const canConfirmReceived = isRecipient && isSent && !isReceived;

  return {
    isPayer,
    isRecipient,
    isSent,
    isReceived,
    canMarkSent,
    canConfirmReceived,
    actionLabel: canMarkSent
      ? 'I sent it'
      : canConfirmReceived
        ? 'I received it'
        : null,
  };
}

function normalizeZeroDecimalInput(value: string): string | null {
  if (/^\d+$/.test(value)) {
    return normalizeInteger(value);
  }

  if (!/^\d{1,3}(?:[.,\s]\d{3})+$/.test(value)) {
    return null;
  }

  return normalizeInteger(value.replace(/[.,\s]/g, ''));
}

function normalizeDecimalInput(value: string): string | null {
  const match =
    /^(?:(\d+)|(\d{1,3}(?:,\d{3})+))(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    return null;
  }

  const integer = normalizeInteger((match[1] ?? match[2]).replace(/,/g, ''));
  const fraction = match[3];
  return fraction === undefined ? integer : `${integer}.${fraction}`;
}

function normalizeInteger(value: string): string {
  const withoutLeadingZeros = value.replace(/^0+(?=\d)/, '');
  return withoutLeadingZeros || '0';
}

function hasValidDecimalPrecision(
  value: string,
  currencyScale: 0 | 2,
): boolean {
  const [integer, fraction = ''] = value.split('.');
  const wholeDigits = integer === '0' ? 0 : integer.length;
  const totalDigits = wholeDigits + fraction.length;

  return (
    fraction.length <= currencyScale &&
    wholeDigits <= EXPENSE_MAX_WHOLE_DIGITS &&
    totalDigits <= EXPENSE_MAX_DIGITS
  );
}

function hasNonZeroDigit(value: string): boolean {
  return /[1-9]/.test(value);
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, percent));
}
