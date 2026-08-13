import { FontAwesome6 } from '@expo/vector-icons';
import { memo } from 'react';
import { colors } from '@/shared/theme/tokens';
import type { AllowedReactionEmoji } from '../types';

export const REACTION_ICON_NAMES = {
  '❤️': 'heart',
  '😂': 'face-laugh-squint',
  '😮': 'face-surprise',
  '😢': 'face-sad-tear',
  '😡': 'face-angry',
  '👍': 'thumbs-up',
  '👎': 'thumbs-down',
} as const satisfies Record<AllowedReactionEmoji, string>;

const REACTION_ICON_COLORS = {
  '❤️': colors.danger,
  '😂': colors.warning,
  '😮': colors.violet,
  '😢': colors.primary,
  '😡': colors.danger,
  '👍': colors.primary,
  '👎': colors.textMuted,
} as const satisfies Record<AllowedReactionEmoji, string>;

interface ChatReactionIconProps {
  emoji: AllowedReactionEmoji;
  size?: number;
}

/**
 * App-bundled vector equivalents for the reaction protocol's Unicode values.
 * The API value remains the exact emoji; only presentation avoids depending on
 * the host OS emoji font, which is unreliable in some iOS Simulator runtimes.
 */
export const ChatReactionIcon = memo(function ChatReactionIcon({
  emoji,
  size = 20,
}: ChatReactionIconProps) {
  return (
    <FontAwesome6
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      color={REACTION_ICON_COLORS[emoji]}
      name={REACTION_ICON_NAMES[emoji]}
      size={size}
      solid
      testID={`chat-reaction-icon-${emoji}`}
    />
  );
});
