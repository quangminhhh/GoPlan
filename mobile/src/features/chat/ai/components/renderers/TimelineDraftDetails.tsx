import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { isAIRecord, type AIActionDraft } from '../../drafts';
import {
  displayMetaRows,
  readAIText,
  type AIDisplayMetaRow,
} from '../../presentation';
import { DetailRows } from './shared';

const SYSTEM_TYPE_LABELS: Readonly<Record<string, string>> = {
  TRANSPORTATION: 'Transportation',
  FOOD: 'Food',
  CHECKIN_OUT: 'Check-in / Check-out',
  FREE_TIME: 'Free time',
  SIGHTSEEING: 'Sightseeing',
  SHOPPING: 'Shopping',
  ACCOMMODATION: 'Accommodation',
  OTHER: 'Other',
};

const ASSIGNEE_LABELS: Readonly<Record<string, string>> = {
  GROUP: 'Whole group',
  EVERYONE: 'Whole group',
  USER: 'Assigned member',
  NONE: 'Unassigned',
};

function activityPreview(draft: AIActionDraft): Readonly<Record<string, unknown>> {
  if (isAIRecord(draft.preview.resolved_data)) {
    return draft.preview.resolved_data;
  }
  return isAIRecord(draft.preview.data) ? draft.preview.data : draft.preview;
}

function firstText(
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

function timeText(source: Readonly<Record<string, unknown>>): string | null {
  const start = firstText([source], ['start_time']);
  const end = firstText([source], ['end_time']);
  if (start !== null) {
    return end === null ? start : `${start} – ${end}`;
  }
  const mode = firstText([source], ['time_mode']);
  if (mode === 'ALL_DAY') {
    return 'All day';
  }
  if (mode === 'FLEXIBLE') {
    return 'Flexible';
  }
  return null;
}

function locationText(source: Readonly<Record<string, unknown>>): string | null {
  const locationMode = firstText([source], ['location_mode']);
  if (locationMode === 'STRUCTURED') {
    const structuredPlace = source.place;
    return isAIRecord(structuredPlace)
      ? firstText([structuredPlace], ['title', 'address'])
      : null;
  }
  const direct = firstText([source], ['location_label', 'location']);
  if (direct !== null) {
    return direct;
  }
  const place = source.place;
  return isAIRecord(place)
    ? firstText([place], ['title', 'address'])
    : null;
}

function append(
  rows: AIDisplayMetaRow[],
  label: string,
  value: string | null,
): void {
  if (value !== null && !rows.some((row) => row.label === label)) {
    rows.push({ label, value });
  }
}

export function TimelineDraftDetails({ draft }: { readonly draft: AIActionDraft }) {
  const activity = activityPreview(draft);
  const sources = [activity, draft.preview];
  const rows: AIDisplayMetaRow[] = [];
  append(rows, 'Section', firstText(sources, ['section_label', 'section_title']));
  append(rows, 'Date', firstText(sources, ['section_date', 'date']));
  append(rows, 'Time', timeText(activity));
  const customType = firstText([activity], ['custom_type_label']);
  const systemType = firstText([activity], ['system_type']);
  append(
    rows,
    'Type',
    customType ?? (
      systemType === null ? null : (SYSTEM_TYPE_LABELS[systemType] ?? systemType)
    ),
  );
  append(rows, 'Location', locationText(activity));
  const assignee = firstText(
    [activity],
    ['assignee_label', 'assignee_name', 'assignee_scope'],
  );
  append(
    rows,
    'Assignee',
    assignee === null ? null : (ASSIGNEE_LABELS[assignee] ?? assignee),
  );
  for (const meta of displayMetaRows(draft.display)) {
    append(rows, meta.label, meta.value);
  }
  const title = firstText([activity, draft.display], ['title']);
  const externalLink = readAIText(activity, 'external_link');
  const hasExternalLinkMeta = rows.some(
    (row) => row.label === 'External link',
  );

  return (
    <View style={styles.container} testID="ai-timeline-draft-details">
      {title !== null ? <Text style={styles.title}>{title}</Text> : null}
      <DetailRows rows={rows} />
      {externalLink !== null && !hasExternalLinkMeta ? (
        <Text style={styles.inertLink}>
          Link (text only): {externalLink}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  title: { ...typography.body, color: colors.text, fontWeight: '700' },
  inertLink: { ...typography.caption, color: colors.textMuted },
});
