import {
  isAIRecord,
  type AIActionDraft,
  type OpaqueAIValue,
} from './drafts';

export interface AIDisplayMetaRow {
  readonly label: string;
  readonly value: string;
}

export interface AIAmountPresentation {
  readonly value: string;
  readonly currency: string;
}

export function readAIText(
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = source[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function primitiveText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null) {
    return 'null';
  }
  return null;
}

function stringifyAIValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
): string {
  const primitive = primitiveText(value);
  if (primitive !== null) {
    return primitive;
  }
  if (depth >= 4) {
    return '[nested value]';
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[circular value]';
    }
    seen.add(value);
    const text = `[${value
      .slice(0, 30)
      .map((item) => stringifyAIValue(item, seen, depth + 1))
      .join(', ')}${value.length > 30 ? ', …' : ''}]`;
    seen.delete(value);
    return text;
  }
  if (isAIRecord(value)) {
    if (seen.has(value)) {
      return '[circular value]';
    }
    seen.add(value);
    const entries = Object.entries(value);
    const text = `{${entries
      .slice(0, 30)
      .map(
        ([key, entry]) =>
          `${key}: ${stringifyAIValue(entry, seen, depth + 1)}`,
      )
      .join(', ')}${entries.length > 30 ? ', …' : ''}}`;
    seen.delete(value);
    return text;
  }
  return '[unsupported value]';
}

/** Converts unknown JSON to inert text; it never returns a React node or URL. */
export function safeAIValueText(value: unknown): string {
  return stringifyAIValue(value, new Set<object>(), 0);
}

export function humanizeAIKey(value: string): string {
  const words = value.replace(/[._-]+/g, ' ').trim();
  return words.length > 0
    ? `${words.charAt(0).toUpperCase()}${words.slice(1)}`
    : 'Value';
}

export function draftTitle(draft: AIActionDraft): string {
  return (
    readAIText(draft.display, 'title') ??
    (draft.summary.trim().length > 0 ? draft.summary.trim() : null) ??
    humanizeAIKey(draft.action_type)
  );
}

export function draftKicker(draft: AIActionDraft): string {
  return (
    readAIText(draft.display, 'kicker') ?? humanizeAIKey(draft.action_type)
  );
}

export function displayMetaRows(display: OpaqueAIValue): readonly AIDisplayMetaRow[] {
  const meta = display.meta;
  if (!Array.isArray(meta)) {
    return [];
  }
  const rows: AIDisplayMetaRow[] = [];
  for (const candidate of meta) {
    if (!isAIRecord(candidate) || typeof candidate.label !== 'string') {
      continue;
    }
    const label = candidate.label.trim();
    const value = primitiveText(candidate.value);
    if (label.length > 0 && value !== null && value.trim().length > 0) {
      rows.push({ label, value: value.trim() });
    }
  }
  return rows;
}

export function displayAmount(
  draft: AIActionDraft,
): AIAmountPresentation | null {
  const hero = draft.display.hero;
  if (isAIRecord(hero) && hero.kind === 'amount') {
    const value = primitiveText(hero.value);
    const currency = primitiveText(hero.currency);
    if (value !== null && currency !== null) {
      return { value, currency };
    }
  }
  const amount =
    primitiveText(draft.preview.total_amount) ??
    primitiveText(draft.preview.amount);
  const currency =
    primitiveText(draft.preview.currency_code) ??
    primitiveText(draft.preview.currency);
  return amount !== null && currency !== null ? { value: amount, currency } : null;
}

export function previewRows(
  preview: OpaqueAIValue,
): readonly AIDisplayMetaRow[] {
  return Object.entries(preview).map(([key, value]) => ({
    label: humanizeAIKey(key),
    value: safeAIValueText(value),
  }));
}

function quotedTitle(draft: AIActionDraft): string {
  return `“${draftTitle(draft)}”`;
}

function amountSuffix(draft: AIActionDraft): string {
  const amount = displayAmount(draft);
  return amount === null ? '' : ` for ${amount.value} ${amount.currency}`;
}

export function confirmationRestatement(draft: AIActionDraft): string {
  switch (draft.action_type) {
    case 'timeline.activity.create':
      return `Create timeline activity ${quotedTitle(draft)}.`;
    case 'timeline.activity.update':
      return `Update timeline activity ${quotedTitle(draft)} with the reviewed values.`;
    case 'timeline.activity.delete':
      return `Delete timeline activity ${quotedTitle(draft)} from the shared trip.`;
    case 'timeline.activity.status.update':
      return `Change the status of timeline activity ${quotedTitle(draft)}.`;
    case 'expense.create':
      return `Create expense ${quotedTitle(draft)}${amountSuffix(draft)}.`;
    case 'expense.update':
      return `Update expense ${quotedTitle(draft)}${amountSuffix(draft)}.`;
    case 'expense.delete':
      return `Delete expense ${quotedTitle(draft)} from the shared trip.`;
    case 'expense.contribution.set':
      return `Change participant contributions for ${quotedTitle(draft)}.`;
    case 'settlement.finalize':
      return 'Finalize the settlement and lock the current expense calculation.';
    case 'settlement.reopen':
      return 'Reopen the finalized settlement so expense balances can change again.';
    case 'settlement.transfer.mark_sent':
      return `Mark this settlement transfer${amountSuffix(draft)} as sent by the payer.`;
    case 'settlement.transfer.confirm_received':
      return `Confirm that this settlement transfer${amountSuffix(draft)} was received by the recipient.`;
    default:
      return `Execute this AI-proposed action: ${quotedTitle(draft)}.`;
  }
}

export function confirmationAuthorityText(draft: AIActionDraft): string {
  switch (draft.required_confirmation) {
    case 'CAPTAIN':
      return 'The server requires an active trip captain.';
    case 'TIMELINE_ACTIVITY_STATUS':
      return 'The server requires permission to update this activity status.';
    case 'TRANSFER_PAYER':
      return 'The server requires the transfer payer.';
    case 'TRANSFER_RECIPIENT':
      return 'The server requires the transfer recipient.';
    case '':
      return 'The server will verify your permission when you confirm.';
    default:
      return `Server confirmation rule: ${draft.required_confirmation}.`;
  }
}
