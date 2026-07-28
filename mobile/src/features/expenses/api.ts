import { apiClient } from '@/shared/api/client';
import type {
  ContributionResponse,
  CreateExpensePayload,
  ExpenseDashboardResponse,
  ExpenseDetailResponse,
  ExpenseResponse,
  SetContributionPayload,
  SettlementTransfer,
  TripSettlement,
  UpdateExpensePayload,
} from './types';

export async function getExpenseDashboard(
  tripId: string,
  signal?: AbortSignal,
): Promise<ExpenseDashboardResponse> {
  const { data } = await apiClient.get<ExpenseDashboardResponse>(
    `/trips/${tripId}/expenses`,
    { signal },
  );
  return data;
}

export async function getExpenseDetail(
  tripId: string,
  expenseId: string,
  signal?: AbortSignal,
): Promise<ExpenseDetailResponse> {
  const { data } = await apiClient.get<ExpenseDetailResponse>(
    `/trips/${tripId}/expenses/${expenseId}`,
    { signal },
  );
  return data;
}

export async function createExpense(
  tripId: string,
  payload: CreateExpensePayload,
): Promise<ExpenseResponse> {
  const { data } = await apiClient.post<ExpenseResponse>(
    `/trips/${tripId}/expenses`,
    payload,
  );
  return data;
}

export async function updateExpense(
  tripId: string,
  expenseId: string,
  payload: UpdateExpensePayload,
): Promise<ExpenseDetailResponse> {
  const { data } = await apiClient.patch<ExpenseDetailResponse>(
    `/trips/${tripId}/expenses/${expenseId}`,
    payload,
  );
  return data;
}

export async function deleteExpense(
  tripId: string,
  expenseId: string,
): Promise<void> {
  await apiClient.delete(`/trips/${tripId}/expenses/${expenseId}`);
}

export async function setContribution(
  tripId: string,
  expenseId: string,
  userId: string,
  payload: SetContributionPayload,
): Promise<ContributionResponse> {
  const { data } = await apiClient.patch<ContributionResponse>(
    `/trips/${tripId}/expenses/${expenseId}/contributions/${userId}`,
    payload,
  );
  return data;
}

export async function finalizeSettlement(
  tripId: string,
): Promise<TripSettlement> {
  const { data } = await apiClient.post<TripSettlement>(
    `/trips/${tripId}/settlement/finalize`,
  );
  return data;
}

export async function reopenSettlement(
  tripId: string,
): Promise<TripSettlement> {
  const { data } = await apiClient.post<TripSettlement>(
    `/trips/${tripId}/settlement/reopen`,
  );
  return data;
}

export async function markTransferSent(
  tripId: string,
  transferId: string,
): Promise<SettlementTransfer> {
  const { data } = await apiClient.post<SettlementTransfer>(
    `/trips/${tripId}/settlement/transfers/${transferId}/sent`,
  );
  return data;
}

export async function confirmTransferReceived(
  tripId: string,
  transferId: string,
): Promise<SettlementTransfer> {
  const { data } = await apiClient.post<SettlementTransfer>(
    `/trips/${tripId}/settlement/transfers/${transferId}/received`,
  );
  return data;
}
