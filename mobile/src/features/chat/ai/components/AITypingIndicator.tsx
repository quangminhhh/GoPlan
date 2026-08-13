import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';

export function AITypingIndicator(props: {
  readonly interactionId: string;
}) {
  return (
    <View
      accessibilityLabel="GoPlanAI is replying"
      accessibilityLiveRegion="polite"
      style={styles.row}
      testID={`goplan-ai-typing-${props.interactionId}`}
    >
      <View accessibilityElementsHidden style={styles.avatar}>
        <Text style={styles.avatarText}>AI</Text>
      </View>
      <View style={styles.bubble}>
        <Text style={styles.label}>GoPlanAI is replying…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  avatar: {
    width: spacing.xl,
    height: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.slateSoft,
  },
  avatarText: {
    ...typography.label,
    color: colors.slate,
  },
  bubble: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  label: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
