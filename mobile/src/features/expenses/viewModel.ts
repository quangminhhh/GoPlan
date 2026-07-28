import type { TripMember } from '@/features/trips/types';
import type {
  ExpenseDashboardResponse,
  ExpenseListItem,
  ExpensePerson,
  SettlementTransfer,
} from './types';

export interface ExpenseTransferDashboardRow {
  type: 'transfer';
  key: string;
  transfer: SettlementTransfer;
}

export interface ExpenseMemberBalanceDashboardRow {
  type: 'member-balance';
  key: string;
  userId: string;
  displayName: string;
  identifyTag: string | null;
  balance: string;
}

export interface ExpenseItemDashboardRow {
  type: 'expense';
  key: string;
  expense: ExpenseListItem;
}

export interface ExpenseEmptyDashboardRow {
  type: 'empty';
  key: 'expense:empty';
}

export type ExpenseDashboardRow =
  | ExpenseTransferDashboardRow
  | ExpenseMemberBalanceDashboardRow
  | ExpenseItemDashboardRow
  | ExpenseEmptyDashboardRow;

interface ResolvedMemberName {
  displayName: string;
  identifyTag: string | null;
}

export function buildExpenseDashboardRows(
  dashboard: ExpenseDashboardResponse,
  activeMembers: readonly TripMember[] = [],
): ExpenseDashboardRow[] {
  const rows: ExpenseDashboardRow[] = [];
  const transfers = dashboard.settlement?.transfers ?? [];

  for (const transfer of transfers) {
    rows.push({
      type: 'transfer',
      key: `transfer:${transfer.id}`,
      transfer,
    });
  }

  const memberNames = buildMemberNameMap(activeMembers, transfers);
  for (const [userId, memberBalance] of Object.entries(
    dashboard.member_balances,
  )) {
    const member = memberNames.get(userId);
    rows.push({
      type: 'member-balance',
      key: `member-balance:${userId}`,
      userId,
      displayName: member?.displayName ?? 'Member',
      identifyTag: member?.identifyTag ?? null,
      balance: memberBalance.balance,
    });
  }

  if (dashboard.expenses.length === 0) {
    rows.push({
      type: 'empty',
      key: 'expense:empty',
    });
  } else {
    for (const expense of dashboard.expenses) {
      rows.push({
        type: 'expense',
        key: `expense:${expense.id}`,
        expense,
      });
    }
  }

  return rows;
}

export function getExpenseDashboardRowKey(
  row: ExpenseDashboardRow,
): string {
  return row.key;
}

function buildMemberNameMap(
  activeMembers: readonly TripMember[],
  transfers: readonly SettlementTransfer[],
): Map<string, ResolvedMemberName> {
  const namesByUserId = new Map<string, ResolvedMemberName>();

  for (const member of activeMembers) {
    namesByUserId.set(member.user.id, {
      displayName: safeDisplayName(member.user.display_name),
      identifyTag: safeIdentifyTag(member.user.identify_tag),
    });
  }

  for (const transfer of transfers) {
    addTransferPartyFallback(namesByUserId, transfer.payer);
    addTransferPartyFallback(namesByUserId, transfer.recipient);
  }

  return namesByUserId;
}

function addTransferPartyFallback(
  namesByUserId: Map<string, ResolvedMemberName>,
  person: ExpensePerson,
): void {
  if (namesByUserId.has(person.id)) {
    return;
  }

  namesByUserId.set(person.id, {
    displayName: safeDisplayName(person.display_name),
    identifyTag: safeIdentifyTag(person.identify_tag),
  });
}

function safeDisplayName(displayName: string): string {
  return displayName.trim() || 'Member';
}

function safeIdentifyTag(identifyTag: string | null): string | null {
  const normalized = identifyTag?.trim() ?? '';
  return normalized || null;
}
