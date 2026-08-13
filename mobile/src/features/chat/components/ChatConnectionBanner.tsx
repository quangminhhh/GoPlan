import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  RealtimeDiagnostics,
  RealtimeStatus,
} from '@/features/realtime/types';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { ChatSubscriptionStatus } from '../hooks/useTripChat';

export const CHAT_CONNECTION_BANNER_DELAY_MS = 2500;
export const CHAT_CONNECTION_BANNER_ESCALATION_MS = 10_000;

type VisibleConnectionState = 'connecting' | 'reconnecting' | 'disconnected';

const CONNECTION_COPY: Record<VisibleConnectionState, string> = {
  connecting: 'Connecting to live chat…',
  reconnecting: 'Reconnecting. You can keep reading; missed messages will catch up.',
  disconnected: 'Live chat is disconnected. New messages may be delayed.',
};

function disconnectedCopy(
  diagnostics: RealtimeDiagnostics | undefined,
): string {
  if (!diagnostics?.terminal) {
    return CONNECTION_COPY.disconnected;
  }
  switch (diagnostics.reason) {
    case 'authentication_failed':
      return 'Live chat stopped because your session could not be authenticated.';
    case 'invalid_configuration':
      return 'Live chat is unavailable because the app configuration is invalid.';
    case 'retry_exhausted':
      return 'Live chat stopped after repeated connection failures. Check your connection and try again later.';
    default:
      return 'Live chat is unavailable and will not retry automatically.';
  }
}

export function ChatConnectionBanner({
  status,
  subscriptionStatus,
  diagnostics,
  onRetry,
}: {
  status: RealtimeStatus;
  subscriptionStatus?: ChatSubscriptionStatus;
  diagnostics?: RealtimeDiagnostics;
  onRetry?: () => void;
}) {
  const visibleStatus: VisibleConnectionState | null =
    status === 'connecting' ||
    (status === 'connected' &&
      (subscriptionStatus === 'waiting' || subscriptionStatus === 'subscribing'))
      ? 'connecting'
      : status === 'reconnecting' || status === 'disconnected'
        ? status
        : null;

  if (visibleStatus === null) {
    return null;
  }

  const copy =
    visibleStatus === 'disconnected'
      ? disconnectedCopy(diagnostics)
      : CONNECTION_COPY[visibleStatus];
  const terminal =
    visibleStatus === 'disconnected' && diagnostics?.terminal === true;

  return (
    <NonConnectedBanner
      copy={copy}
      key={`${visibleStatus}:${copy}`}
      onRetry={
        terminal && diagnostics?.reason === 'retry_exhausted'
          ? onRetry
          : undefined
      }
      terminal={terminal}
    />
  );
}

function NonConnectedBanner({
  copy,
  onRetry,
  terminal,
}: {
  copy: string;
  onRetry?: () => void;
  terminal: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [escalated, setEscalated] = useState(false);

  useEffect(() => {
    const showTimer = setTimeout(
      () => setVisible(true),
      CHAT_CONNECTION_BANNER_DELAY_MS,
    );
    const escalationTimer = setTimeout(
      () => setEscalated(true),
      CHAT_CONNECTION_BANNER_ESCALATION_MS,
    );
    return () => {
      clearTimeout(showTimer);
      clearTimeout(escalationTimer);
    };
  }, []);

  if (!visible) {
    return null;
  }

  const text = (
    <Text
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        styles.bannerText,
        escalated || terminal ? styles.bannerTextEscalated : null,
      ]}
    >
      {copy}
    </Text>
  );

  if (!onRetry) {
    return (
      <View
        style={[
          styles.banner,
          escalated || terminal ? styles.bannerEscalated : null,
        ]}
        testID="chat-connection-banner"
      >
        {text}
      </View>
    );
  }

  return (
    <View
      style={[styles.banner, styles.actionBanner, styles.bannerEscalated]}
      testID="chat-connection-banner"
    >
      {text}
      <Pressable
        accessibilityLabel="Retry live connection"
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [
          styles.retryButton,
          pressed ? styles.retryButtonPressed : null,
        ]}
      >
        <Text style={styles.retryButtonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.completedSoft,
  },
  actionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.sm,
  },
  bannerEscalated: {
    backgroundColor: colors.warningSoft,
  },
  bannerText: { ...typography.caption, flex: 1, color: colors.textMuted },
  bannerTextEscalated: { color: colors.warning },
  retryButton: {
    minHeight: 44,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  retryButtonPressed: { opacity: 0.58 },
  retryButtonText: { ...typography.label, color: colors.primary },
});
