import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  GOPLAN_AI_MENTION,
  GOPLAN_AI_PROMPT_LIMIT_PER_HOUR,
  tokenizeGoPlanAIMention,
} from '../mention';

export interface GoPlanAIMentionTokenProps {
  readonly tone?: 'default' | 'inverse';
}

export function GoPlanAIMentionToken({
  tone = 'default',
}: GoPlanAIMentionTokenProps) {
  return (
    <Text
      accessibilityLabel="GoPlanAI mention"
      style={[
        styles.token,
        tone === 'inverse' ? styles.inverseToken : styles.defaultToken,
      ]}
      testID="goplan-ai-mention-token"
    >
      {GOPLAN_AI_MENTION}
    </Text>
  );
}

export function GoPlanAIMentionMessageText(props: {
  readonly content: string;
  readonly inverse?: boolean;
}) {
  const segments = tokenizeGoPlanAIMention(props.content);
  return (
    <Text style={[styles.message, props.inverse ? styles.inverseText : null]}>
      {segments.map((segment, index) =>
        segment.kind === 'mention' ? (
          <GoPlanAIMentionToken
            key={`mention-${index}`}
            tone={props.inverse ? 'inverse' : 'default'}
          />
        ) : (
          <Text key={`text-${index}`}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}

export function GoPlanAIComposerIntent() {
  return (
    <View
      accessibilityLabel={`Message will be sent to GoPlanAI. Limit ${GOPLAN_AI_PROMPT_LIMIT_PER_HOUR} prompts per hour.`}
      style={styles.intent}
      testID="goplan-ai-composer-intent"
    >
      <GoPlanAIMentionToken />
      <Text style={styles.intentText}>
        {GOPLAN_AI_PROMPT_LIMIT_PER_HOUR} prompts/hour
      </Text>
    </View>
  );
}

export interface GoPlanAIMentionCommandMenuProps {
  readonly open: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export function GoPlanAIMentionCommandMenu({
  open,
  disabled = false,
  onSelect,
}: GoPlanAIMentionCommandMenuProps) {
  if (!open) {
    return null;
  }
  return (
    <View
      accessibilityLabel="Mention suggestions"
      accessibilityRole="menu"
      style={styles.menu}
    >
      <Pressable
        accessibilityHint="Inserts the exact GoPlanAI mention"
        accessibilityLabel="Mention GoPlanAI"
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onSelect}
        style={({ pressed }) => [
          styles.menuItem,
          pressed && !disabled ? styles.pressed : null,
          disabled ? styles.disabled : null,
        ]}
      >
        <GoPlanAIMentionToken />
        <Text style={styles.menuDescription}>Ask GoPlanAI</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  token: {
    ...typography.label,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radii.full,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  defaultToken: {
    color: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  inverseToken: {
    color: colors.background,
    backgroundColor: colors.primaryPressed,
  },
  message: {
    ...typography.body,
    color: colors.text,
  },
  inverseText: { color: colors.background },
  intent: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.primarySoft,
  },
  intentText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  menu: {
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  menuItem: {
    minHeight: 44,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderCurve: 'continuous',
  },
  menuDescription: {
    ...typography.caption,
    color: colors.textMuted,
  },
  pressed: { backgroundColor: colors.surface },
  disabled: { opacity: 0.45 },
});
