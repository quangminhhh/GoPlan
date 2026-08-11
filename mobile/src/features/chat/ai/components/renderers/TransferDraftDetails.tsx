import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { AIActionDraft } from '../../drafts';
import { displayMetaRows, readAIText } from '../../presentation';
import { AmountHero, DetailRows } from './shared';

export function TransferDraftDetails({ draft }: { readonly draft: AIActionDraft }) {
  const meta = displayMetaRows(draft.display);
  const from =
    meta.find((row) => row.label.toLowerCase() === 'from')?.value ??
    readAIText(draft.preview, 'from_name') ??
    readAIText(draft.preview, 'payer_name') ??
    'Payer';
  const to =
    meta.find((row) => row.label.toLowerCase() === 'to')?.value ??
    readAIText(draft.preview, 'to_name') ??
    readAIText(draft.preview, 'recipient_name') ??
    'Recipient';
  const assertion =
    draft.action_type === 'settlement.transfer.mark_sent'
      ? 'The payer is asserting that this transfer was sent.'
      : 'The recipient is asserting that this transfer was received.';
  return (
    <View style={styles.container} testID="ai-transfer-draft-details">
      <Text style={styles.direction}>{from} → {to}</Text>
      <AmountHero draft={draft} />
      <Text style={styles.assertion}>{assertion}</Text>
      <DetailRows rows={meta} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  direction: {
    ...typography.body,
    color: colors.text,
    fontWeight: '700',
  },
  assertion: { ...typography.caption, color: colors.textMuted },
});
