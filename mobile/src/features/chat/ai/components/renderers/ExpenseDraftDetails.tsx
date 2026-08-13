import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { AIActionDraft } from '../../drafts';
import {
  displayMetaRows,
  readAIText,
  safeAIValueText,
  type AIDisplayMetaRow,
} from '../../presentation';
import { AmountHero, DetailRows } from './shared';

function append(
  rows: AIDisplayMetaRow[],
  label: string,
  value: string | null,
): void {
  if (value !== null && !rows.some((row) => row.label === label)) {
    rows.push({ label, value });
  }
}

function participantText(draft: AIActionDraft): string | null {
  const participants =
    draft.preview.participants ??
    draft.preview.member_contributions ??
    draft.preview.contributions;
  if (participants === undefined) {
    return null;
  }
  return safeAIValueText(participants);
}

export function ExpenseDraftDetails({ draft }: { readonly draft: AIActionDraft }) {
  const rows: AIDisplayMetaRow[] = [];
  append(
    rows,
    'Payer / collector',
    readAIText(draft.preview, 'payer_name') ??
      readAIText(draft.preview, 'collector_name') ??
      readAIText(draft.preview, 'collector_id'),
  );
  append(rows, 'Participants', participantText(draft));
  append(
    rows,
    'Split',
    readAIText(draft.preview, 'split_type') ??
      readAIText(draft.preview, 'split_method') ??
      readAIText(draft.preview, 'scope'),
  );
  for (const meta of displayMetaRows(draft.display)) {
    append(rows, meta.label, meta.value);
  }

  return (
    <View style={styles.container} testID="ai-expense-draft-details">
      <AmountHero draft={draft} />
      <DetailRows rows={rows} />
      {draft.action_type === 'expense.delete' ? (
        <Text style={styles.destructive}>
          This removes the expense from the shared trip.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  destructive: { ...typography.caption, color: colors.danger },
});
