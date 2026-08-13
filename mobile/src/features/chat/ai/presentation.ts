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

function timelineActivityPreview(
  draft: AIActionDraft,
): Readonly<Record<string, unknown>> {
  if (isAIRecord(draft.preview.resolved_data)) {
    return draft.preview.resolved_data;
  }
  return isAIRecord(draft.preview.data) ? draft.preview.data : draft.preview;
}

function timelineDisplayText(
  draft: AIActionDraft,
  label: 'Target' | 'Date' | 'Time' | 'Location',
): string | null {
  const meta = draft.display.meta;
  if (!Array.isArray(meta)) {
    return null;
  }
  for (const candidate of meta) {
    if (
      !isAIRecord(candidate) ||
      candidate.label !== label ||
      typeof candidate.value !== 'string'
    ) {
      continue;
    }
    const value = candidate.value.trim();
    if (value.length > 0) {
      return value;
    }
  }
  return null;
}

function firstTimelineText(
  sources: readonly Readonly<Record<string, unknown>>[],
  keys: readonly string[],
): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = readAIText(source, key);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

function timelineTimeText(
  activity: Readonly<Record<string, unknown>>,
): string | null {
  const start = firstTimelineText([activity], ['start_time']);
  const end = firstTimelineText([activity], ['end_time']);
  if (start !== null) {
    return end === null ? start : `${start} – ${end}`;
  }
  const mode = firstTimelineText([activity], ['time_mode']);
  if (mode === 'ALL_DAY') {
    return 'All day';
  }
  if (mode === 'FLEXIBLE') {
    return 'Flexible';
  }
  return null;
}

function timelineLocationText(
  activity: Readonly<Record<string, unknown>>,
): string | null {
  const locationMode = firstTimelineText([activity], ['location_mode']);
  if (locationMode === 'STRUCTURED') {
    return isAIRecord(activity.place)
      ? firstTimelineText([activity.place], ['title', 'address'])
      : null;
  }
  const direct = firstTimelineText(
    [activity],
    ['location_label', 'location'],
  );
  if (direct !== null) {
    return direct;
  }
  return isAIRecord(activity.place)
    ? firstTimelineText([activity.place], ['title', 'address'])
    : null;
}

const TIMELINE_CONFIRMATION_DETAIL_LABELS = new Set([
  'Type',
  'Custom type',
  'Assignee',
  'Assigned member',
  'Booking reference',
  'Contact name',
  'Contact phone',
  'External link',
  'Location note',
  'Meeting point',
  'Note',
  'Reminders',
]);

function timelineConfirmationMetaDetails(draft: AIActionDraft): string[] {
  return displayMetaRows(draft.display)
    .filter(({ label }) => TIMELINE_CONFIRMATION_DETAIL_LABELS.has(label))
    .map(({ label, value }) => `${label}: ${value}.`);
}

function timelineConfirmationDetails(draft: AIActionDraft): string {
  const activity = timelineActivityPreview(draft);
  const sectionLabel = firstTimelineText([draft.preview], ['section_label']);
  const sectionDate = firstTimelineText(
    [draft.preview],
    ['section_date', 'date'],
  );
  const fallbackDate =
    sectionLabel !== null && sectionDate !== null
      ? `${sectionLabel} · ${sectionDate}`
      : (sectionDate ?? sectionLabel);
  const date = timelineDisplayText(draft, 'Date') ?? fallbackDate;
  const time = timelineDisplayText(draft, 'Time') ?? timelineTimeText(activity);
  const location =
    timelineDisplayText(draft, 'Location') ?? timelineLocationText(activity);
  const details = [
    date === null ? null : `Date: ${date}.`,
    time === null ? null : `Time: ${time}.`,
    location === null ? null : `Location: ${location}.`,
    ...timelineConfirmationMetaDetails(draft),
  ].filter((detail): detail is string => detail !== null);
  return details.length === 0 ? '' : ` ${details.join(' ')}`;
}

function quotedTimelineUpdateTarget(draft: AIActionDraft): string {
  const target =
    timelineDisplayText(draft, 'Target') ??
    firstTimelineText([draft.preview], ['target_title']) ??
    draftTitle(draft);
  return `“${target}”`;
}

function timelineUpdateTitleSuffix(draft: AIActionDraft): string {
  const target =
    timelineDisplayText(draft, 'Target') ??
    firstTimelineText([draft.preview], ['target_title']) ??
    draftTitle(draft);
  const resolvedTitle =
    firstTimelineText([timelineActivityPreview(draft)], ['title']) ??
    draftTitle(draft);
  return resolvedTitle === target ? '' : ` to “${resolvedTitle}”`;
}

export function confirmationRestatement(draft: AIActionDraft): string {
  switch (draft.action_type) {
    case 'timeline.activity.create':
      return `Create timeline activity ${quotedTitle(draft)}.${timelineConfirmationDetails(draft)}`;
    case 'timeline.activity.update':
      return `Update timeline activity ${quotedTimelineUpdateTarget(draft)}${timelineUpdateTitleSuffix(draft)}.${timelineConfirmationDetails(draft)}`;
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
