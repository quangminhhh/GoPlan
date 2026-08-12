import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { RealtimeStatus } from '@/features/realtime/types';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { ChatSubscriptionStatus } from '../hooks/useTripChat';

export const CHAT_CONNECTION_BANNER_DELAY_MS = 2500;
export const CHAT_CONNECTION_BANNER_ESCALATION_MS = 10_000;

type VisibleConnectionState = 'connecting' | 'reconnecting' | 'disconnected';

const CONNECTION_COPY: Record<VisibleConnectionState, string> = {
  connecting: 'Connecting to live chat…',
  reconnecting: 'Reconnecting. You can keep reading; missed messages will catch up.',
  disconnected: 'Disconnected. Trying again shortly.',
};

export function ChatConnectionBanner({
  status,
  subscriptionStatus,
}: {
  status: RealtimeStatus;
  subscriptionStatus?: ChatSubscriptionStatus;
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

  return <NonConnectedBanner key={visibleStatus} status={visibleStatus} />;
}

function NonConnectedBanner({
  status,
}: {
  status: VisibleConnectionState;
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

  return (
    <Text
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.banner, escalated ? styles.bannerEscalated : null]}
      testID="chat-connection-banner"
    >
      {CONNECTION_COPY[status]}
    </Text>
  );
}

const styles = StyleSheet.create({
  banner: {
    ...typography.caption,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textMuted,
    backgroundColor: colors.completedSoft,
  },
  bannerEscalated: {
    color: colors.warning,
    backgroundColor: colors.warningSoft,
  },
});
