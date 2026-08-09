import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  useWindowDimensions,
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
  const { fontScale } = useWindowDimensions();
  const stackActions = Number.isFinite(fontScale) && fontScale >= 1.3;

  return (
    <View style={[styles.toast, stackActions && styles.toastStacked, style]} testID={testID}>
      <Text
        key={message}
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        style={[styles.message, stackActions && styles.messageStacked]}
        testID={`${testID}-message`}
      >
        {message}
      </Text>
      <View style={[styles.controls, stackActions && styles.controlsStacked]}>
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
  toastStacked: {
    alignItems: 'stretch',
    flexDirection: 'column',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  message: {
    ...typography.caption,
    color: colors.background,
    flex: 1,
    paddingVertical: spacing.md,
    textAlign: 'center',
  },
  messageStacked: {
    flex: 0,
    paddingVertical: spacing.xs,
    textAlign: 'left',
  },
  controls: { alignItems: 'center', flexDirection: 'row' },
  controlsStacked: { alignSelf: 'flex-end' },
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
  actionText: { ...typography.label, color: colors.background, textAlign: 'center' },
});
