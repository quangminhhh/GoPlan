import type { TripMember } from '@/features/trips/types';
import {
  normalizeExpenseMoneyInput,
  type NormalizedExpenseMoneyInput,
} from './money';
import type {
  CreateExpensePayload,
  ExpenseDetailResponse,
  ExpenseParticipant,
  ExpensePerson,
  SetContributionPayload,
  UpdateExpensePayload,
} from './types';

export const EXPENSE_FIELD_LIMITS = {
  title: 120,
} as const;

const EXPENSE_DRAFT_FIELDS = [
  'title',
  'description',
  'total_amount',
  'collector_id',
] as const;

export interface ExpenseFormDraft {
  title: string;
  description: string;
  total_amount: string;
  collector_id: string | null;
}

export type ExpenseDraftField = (typeof EXPENSE_DRAFT_FIELDS)[number];

export type ExpenseFormDirtyFields = Readonly<
  Partial<Record<ExpenseDraftField, boolean>>
>;

export type ExpenseFormFieldErrors = Partial<
  Record<ExpenseDraftField, string>
>;

export interface ExpenseFormValidationOptions {
  mode?: 'create' | 'edit';
  eligibleCollectorIds?: ReadonlySet<string> | readonly string[];
  initialCollectorId?: string | null;
}

export interface ExpenseFormValidationResult {
  isValid: boolean;
  fieldErrors: ExpenseFormFieldErrors;
}

export function createExpenseDraft(
  collectorId: string | null = null,
): ExpenseFormDraft {
  return {
    title: '',
    description: '',
    total_amount: '',
    collector_id: collectorId,
  };
}

export function hydrateExpenseDraft(
  expense: ExpenseDetailResponse,
): ExpenseFormDraft {
  return {
    title: expense.title,
    description: expense.description,
    total_amount: expense.total_amount,
    collector_id: expense.collector.id,
  };
}

export function cloneExpenseDraft(
  draft: ExpenseFormDraft,
): ExpenseFormDraft {
  return { ...draft };
}

export function validateExpenseDraft(
  draft: ExpenseFormDraft,
  currencyCode: string,
  {
    mode = 'create',
    eligibleCollectorIds,
    initialCollectorId = null,
  }: ExpenseFormValidationOptions = {},
): ExpenseFormValidationResult {
  const fieldErrors: ExpenseFormFieldErrors = {};
  const normalizedTitle = draft.title.trim();

  if (!normalizedTitle) {
    fieldErrors.title = 'Title is required.';
  } else if (
    codePointLength(normalizedTitle) > EXPENSE_FIELD_LIMITS.title
  ) {
    fieldErrors.title =
      `Title must be ${EXPENSE_FIELD_LIMITS.title} characters or fewer.`;
  }

  const normalizedAmount = normalizeExpenseMoneyInput(
    draft.total_amount,
    currencyCode,
    { minimum: 'positive' },
  );
  if (normalizedAmount.error) {
    fieldErrors.total_amount = normalizedAmount.error;
  }

  const collectorId = normalizeCollectorId(draft.collector_id);
  if (mode === 'edit' && !collectorId) {
    fieldErrors.collector_id = 'Choose a collector.';
  } else if (
    collectorId &&
    eligibleCollectorIds &&
    collectorId !== initialCollectorId &&
    !containsId(eligibleCollectorIds, collectorId)
  ) {
    fieldErrors.collector_id =
      'Choose an eligible active trip member.';
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

export function buildCreateExpensePayload(
  draft: ExpenseFormDraft,
  currencyCode: string,
  eligibleCollectorIds?: ReadonlySet<string> | readonly string[],
): CreateExpensePayload | null {
  const validation = validateExpenseDraft(draft, currencyCode, {
    mode: 'create',
    eligibleCollectorIds,
  });
  const totalAmount = normalizeExpenseMoneyInput(
    draft.total_amount,
    currencyCode,
    { minimum: 'positive' },
  ).value;

  if (!validation.isValid || totalAmount === null) {
    return null;
  }

  const collectorId = normalizeCollectorId(draft.collector_id);
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    total_amount: totalAmount,
    ...(collectorId ? { collector_id: collectorId } : {}),
  };
}

export function getExpenseDirtyFields(
  initialDraft: ExpenseFormDraft,
  draft: ExpenseFormDraft,
): ExpenseFormDirtyFields {
  const dirtyFields: Partial<Record<ExpenseDraftField, boolean>> = {};
  for (const field of EXPENSE_DRAFT_FIELDS) {
    if (initialDraft[field] !== draft[field]) {
      dirtyFields[field] = true;
    }
  }
  return dirtyFields;
}

export function buildPatchExpensePayload(
  initialDraft: ExpenseFormDraft,
  draft: ExpenseFormDraft,
  currencyCode: string,
  dirtyFields: ExpenseFormDirtyFields = getExpenseDirtyFields(
    initialDraft,
    draft,
  ),
  eligibleCollectorIds?: ReadonlySet<string> | readonly string[],
): UpdateExpensePayload | null {
  const initialCollectorId = normalizeCollectorId(
    initialDraft.collector_id,
  );
  const validation = validateExpenseDraft(draft, currencyCode, {
    mode: 'edit',
    eligibleCollectorIds,
    initialCollectorId,
  });
  const totalAmount = normalizeExpenseMoneyInput(
    draft.total_amount,
    currencyCode,
    { minimum: 'positive' },
  ).value;

  if (!validation.isValid || totalAmount === null) {
    return null;
  }

  const patch: UpdateExpensePayload = {};
  const initialTitle = initialDraft.title.trim();
  const nextTitle = draft.title.trim();
  if (dirtyFields.title && initialTitle !== nextTitle) {
    patch.title = nextTitle;
  }

  const initialDescription = initialDraft.description.trim();
  const nextDescription = draft.description.trim();
  if (
    dirtyFields.description &&
    initialDescription !== nextDescription
  ) {
    patch.description = nextDescription;
  }

  const initialTotalAmount = normalizeExpenseMoneyInput(
    initialDraft.total_amount,
    currencyCode,
    { minimum: 'positive' },
  ).value;
  if (
    dirtyFields.total_amount &&
    initialTotalAmount !== totalAmount
  ) {
    patch.total_amount = totalAmount;
  }

  const collectorId = normalizeCollectorId(draft.collector_id);
  if (
    dirtyFields.collector_id &&
    collectorId &&
    collectorId !== initialCollectorId
  ) {
    patch.collector_id = collectorId;
  }

  return patch;
}

export function getEligibleCollectors(
  activeMembers: readonly TripMember[],
  participants?: readonly ExpenseParticipant[],
): TripMember[] {
  if (participants === undefined) {
    return [...activeMembers];
  }

  const participantIds = new Set(
    participants.map((participant) => participant.user_id),
  );
  return activeMembers.filter((member) =>
    participantIds.has(member.user.id),
  );
}

export function getDepartedCurrentCollector(
  collector: ExpensePerson,
  eligibleCollectors: readonly TripMember[],
): ExpensePerson | null {
  return eligibleCollectors.some(
    (member) => member.user.id === collector.id,
  )
    ? null
    : collector;
}

export function validateContributionAmount(
  value: string,
  currencyCode: string,
): NormalizedExpenseMoneyInput {
  return normalizeExpenseMoneyInput(value, currencyCode, {
    minimum: 'non-negative',
  });
}

export function buildContributionPayload(
  value: string,
  currencyCode: string,
): SetContributionPayload | null {
  const normalized = validateContributionAmount(value, currencyCode);
  return normalized.value === null ? null : { amount: normalized.value };
}

function normalizeCollectorId(collectorId: string | null): string | null {
  const normalized = collectorId?.trim() ?? '';
  return normalized || null;
}

function containsId(
  ids: ReadonlySet<string> | readonly string[],
  id: string,
): boolean {
  for (const candidate of ids) {
    if (candidate === id) {
      return true;
    }
  }
  return false;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
