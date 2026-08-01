import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';

interface PhotoFeedbackToastProps {
  message: string;
  onDismiss: () => void;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Announces the useful outcome text itself and keeps dismissal as a separate
 * accessible action. The container deliberately has no accessibility label so
 * it cannot replace or hide its descendants in the VoiceOver tree.
 */
export function PhotoFeedbackToast({
  message,
  onDismiss,
  actionLabel,
  onAction,
  style,
  testID = 'photo-feedback-toast',
}: PhotoFeedbackToastProps) {
  return (
    <View style={[styles.toast, style]} testID={testID}>
      <Text
        key={message}
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        style={styles.message}
        testID={`${testID}-message`}
      >
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={styles.action}
        >
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss message"
        onPress={onDismiss}
        style={styles.dismiss}
      >
        <Ionicons name="close" size={20} color={colors.background} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingLeft: spacing.md,
  },
  message: {
    ...typography.caption,
    color: colors.background,
    flex: 1,
    paddingVertical: spacing.md,
    textAlign: 'center',
  },
  dismiss: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  action: {
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  actionText: { ...typography.label, color: colors.background },
});
