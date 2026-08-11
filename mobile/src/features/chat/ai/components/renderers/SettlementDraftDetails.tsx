import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { AIActionDraft } from '../../drafts';
import { DisplayMeta, GenericPreview } from './shared';

export function SettlementDraftDetails({ draft }: { readonly draft: AIActionDraft }) {
  const consequence =
    draft.action_type === 'settlement.finalize'
      ? 'Finalizing locks the current settlement calculation and creates the transfers needed to settle balances.'
      : 'Reopening unlocks the settlement so expense balances may change again.';
  return (
    <View style={styles.container} testID="ai-settlement-draft-details">
      <Text style={styles.consequence}>{consequence}</Text>
      <DisplayMeta draft={draft} />
      {Object.keys(draft.preview).length > 0 ? (
        <GenericPreview draft={draft} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  consequence: { ...typography.body, color: colors.text },
});
