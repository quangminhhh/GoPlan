import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { AIActionDraft } from '../../drafts';
import { GenericPreview } from './shared';

export function GenericDraftDetails({ draft }: { readonly draft: AIActionDraft }) {
  return (
    <View style={styles.container} testID="ai-generic-draft-details">
      <Text style={styles.unknown}>Unknown action type: {draft.action_type}</Text>
      {draft.summary.trim().length > 0 ? (
        <Text style={styles.summary}>{draft.summary}</Text>
      ) : null}
      <GenericPreview draft={draft} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  unknown: { ...typography.caption, color: colors.warning },
  summary: { ...typography.body, color: colors.text },
});
