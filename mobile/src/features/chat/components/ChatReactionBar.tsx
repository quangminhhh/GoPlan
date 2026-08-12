import { FontAwesome6 } from '@expo/vector-icons';
import { memo, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  ALLOWED_REACTION_EMOJIS,
  type AllowedReactionEmoji,
  type ReactionSummary,
} from '../types';
import { ChatReactionIcon } from './ChatReactionIcon';

export const REACTION_ACCESSIBILITY_LABELS: Record<AllowedReactionEmoji, string> = {
  '❤️': 'Heart',
  '😂': 'Face with tears of joy',
  '😮': 'Surprised face',
  '😢': 'Crying face',
  '😡': 'Angry face',
  '👍': 'Thumbs up',
  '👎': 'Thumbs down',
};

interface ChatReactionBarProps {
  reactions: readonly ReactionSummary[];
  currentUserId: string;
  disabled?: boolean;
  busy?: boolean;
  onToggle?: (emoji: AllowedReactionEmoji) => void;
}

interface ReactionChipProps {
  emoji: AllowedReactionEmoji;
  count: number;
  reactedByMe: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle?: (emoji: AllowedReactionEmoji) => void;
}

function formatReactionCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

const ReactionChip = memo(function ReactionChip({
  emoji,
  count,
  reactedByMe,
  disabled,
  busy,
  onToggle,
}: ReactionChipProps) {
  const toggle = useCallback(() => onToggle?.(emoji), [emoji, onToggle]);
  const accessibilityLabel = `${REACTION_ACCESSIBILITY_LABELS[emoji]}, ${count} ${
    count === 1 ? 'reaction' : 'reactions'
  }${reactedByMe ? ', you reacted' : ''}`;
  const content = (
    <>
      <ChatReactionIcon emoji={emoji} />
      <Text style={styles.count}>{formatReactionCount(count)}</Text>
      {reactedByMe ? (
        <FontAwesome6
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          color={colors.primary}
          name="check"
          size={11}
          solid
          testID={`chat-reaction-selected-${emoji}`}
        />
      ) : null}
    </>
  );

  if (disabled || !onToggle) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[styles.chip, reactedByMe ? styles.chipSelected : null]}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={reactedByMe ? 'Removes your reaction' : 'Adds this reaction'}
      accessibilityState={{ selected: reactedByMe, disabled: busy, busy }}
      disabled={busy}
      onPress={toggle}
      style={({ pressed }) => [
        styles.chip,
        reactedByMe ? styles.chipSelected : null,
        pressed && !busy ? styles.chipPressed : null,
        busy ? styles.chipBusy : null,
      ]}
    >
      {content}
    </Pressable>
  );
});

export function ChatReactionBar({
  reactions,
  currentUserId,
  disabled = false,
  busy = false,
  onToggle,
}: ChatReactionBarProps) {
  const orderedReactions = useMemo(
    () =>
      ALLOWED_REACTION_EMOJIS.map((emoji) =>
        reactions.find((reaction) => reaction.emoji === emoji),
      ).filter((reaction): reaction is ReactionSummary => Boolean(reaction && reaction.count > 0)),
    [reactions],
  );

  if (orderedReactions.length === 0) {
    return null;
  }

  return (
    <View style={styles.bar} testID="chat-reaction-bar">
      {orderedReactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          emoji={reaction.emoji}
          count={reaction.count}
          reactedByMe={reaction.reacted_by_ids.includes(currentUserId)}
          disabled={disabled}
          busy={busy}
          onToggle={onToggle}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    maxWidth: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.full,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  chipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  chipPressed: { opacity: 0.58 },
  chipBusy: { opacity: 0.55 },
  count: { ...typography.caption, color: colors.text },
});
