export type ExpenseStatus = 'UNDERFUNDED' | 'FUNDED' | 'OVERFUNDED';
export type ExpenseSettlementStatus = 'FINALIZED' | 'REOPENED';

export interface ExpensePerson {
  id: string;
  display_name: string;
  identify_tag: string | null;
}

export interface ExpenseMoneySummary {
  total_amount: string;
  paid_amount: string;
  missing_amount: string;
  surplus_amount: string;
}

export type ExpenseDashboardSummary = ExpenseMoneySummary;

export interface ExpensePermissions {
  can_manage_expenses: boolean;
}

export interface ExpenseListItem extends ExpenseMoneySummary {
  id: string;
  title: string;
  description: string;
  currency_code: string;
  status: ExpenseStatus;
  collector: ExpensePerson;
  locked: boolean;
}

export interface ExpenseParticipant {
  user_id: string;
  display_name: string;
  identify_tag: string | null;
  share_amount: string;
  contributed_amount: string;
  balance: string;
  surplus_held: string;
}

export type ExpenseParticipantContribution = ExpenseParticipant;

export interface ExpenseDetailResponse extends ExpenseListItem {
  locked_at: string | null;
  created_at: string;
  permissions: ExpensePermissions;
  participants: ExpenseParticipant[];
}

export interface SettlementTransfer {
  id: string;
  payer: ExpensePerson;
  recipient: ExpensePerson;
  amount: string;
  payer_marked_sent_at: string | null;
  recipient_confirmed_at: string | null;
}

export interface TripSettlement {
  id: string;
  status: ExpenseSettlementStatus;
  finalized_at: string | null;
  transfers: SettlementTransfer[];
}

export interface ExpenseDashboardResponse {
  currency_code: string;
  summary: ExpenseMoneySummary;
  permissions: ExpensePermissions;
  my_balance: {
    balance: string;
    surplus_held: string;
  };
  member_balances: Record<string, { balance: string }>;
  settlement: TripSettlement | null;
  expenses: ExpenseListItem[];
}

export interface CreateExpensePayload {
  title: string;
  description?: string;
  total_amount: string;
  collector_id?: string;
}

export type UpdateExpensePayload = Partial<CreateExpensePayload>;

export interface SetContributionPayload {
  amount: string;
}

export interface ExpenseResponse {
  id: string;
  title: string;
  description: string;
  total_amount: string;
  currency_code: string;
  locked_at: string | null;
  created_at: string;
}

export type CreateExpenseResponse = ExpenseResponse;

export interface ContributionResponse {
  id: string;
  user: ExpensePerson;
  amount: string;
  updated_at: string;
}
