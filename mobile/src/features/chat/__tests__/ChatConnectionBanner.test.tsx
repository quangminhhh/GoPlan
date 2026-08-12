import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type {
  RealtimeDiagnosticReason,
  RealtimeDiagnostics,
} from '@/features/realtime/types';
import { colors } from '@/shared/theme/tokens';
import {
  CHAT_CONNECTION_BANNER_DELAY_MS,
  CHAT_CONNECTION_BANNER_ESCALATION_MS,
  ChatConnectionBanner,
} from '../components/ChatConnectionBanner';

function terminalDiagnostics(
  reason: RealtimeDiagnosticReason,
): RealtimeDiagnostics {
  return {
    phase: 'stopped',
    reason,
    category: 'retry',
    terminal: true,
    closeCode: null,
    reconnectAttempt: 5,
    retryDelayMs: null,
    ticketPhase: null,
    heartbeat: 'inactive',
  };
}

describe('ChatConnectionBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stays silent when live chat is connected and subscribed', async () => {
    await render(
      <ChatConnectionBanner status="connected" subscriptionStatus="subscribed" />,
    );
    expect(screen.queryByTestId('chat-connection-banner')).toBeNull();
  });

  it('delays the initial connecting state so a fast handshake does not flash', async () => {
    await render(<ChatConnectionBanner status="connecting" />);

    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
    });
    expect(screen.getByText('Connecting to live chat…')).toBeTruthy();
  });

  it('represents a connected transport that is still subscribing the room', async () => {
    await render(
      <ChatConnectionBanner status="connected" subscriptionStatus="subscribing" />,
    );

    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
    });
    expect(screen.getByText('Connecting to live chat…')).toBeTruthy();
  });

  it('delays transient reconnect noise, then exposes one polite alert', async () => {
    await render(<ChatConnectionBanner status="reconnecting" />);

    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS - 1);
    });
    expect(screen.queryByTestId('chat-connection-banner')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    const alert = screen.getByRole('alert');
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
    expect(alert.props.children).toContain('Reconnecting');
  });

  it('escalates a sustained disconnection without changing the truthful copy', async () => {
    await render(<ChatConnectionBanner status="disconnected" />);

    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_ESCALATION_MS);
    });
    const banner = screen.getByTestId('chat-connection-banner');
    expect(
      screen.getByText(
        'Live chat is disconnected. New messages may be delayed.',
      ),
    ).toBeTruthy();
    expect(StyleSheet.flatten(banner.props.style).backgroundColor).toBe(colors.warningSoft);
  });

  it.each([
    [
      'retry_exhausted',
      'Live chat stopped after repeated connection failures. Check your connection and try again later.',
    ],
    [
      'authentication_failed',
      'Live chat stopped because your session could not be authenticated.',
    ],
    [
      'invalid_configuration',
      'Live chat is unavailable because the app configuration is invalid.',
    ],
  ] as const)(
    'explains terminal transport reason %s without promising another retry',
    async (reason, copy) => {
      await render(
        <ChatConnectionBanner
          diagnostics={terminalDiagnostics(reason)}
          status="disconnected"
        />,
      );

      await act(async () => {
        jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
      });
      const banner = screen.getByTestId('chat-connection-banner');
      expect(screen.getByText(copy)).toBeTruthy();
      expect(StyleSheet.flatten(banner.props.style).backgroundColor).toBe(
        colors.warningSoft,
      );
    },
  );

  it('offers a real manual retry only after automatic retries are exhausted', async () => {
    const onRetry = jest.fn();
    await render(
      <ChatConnectionBanner
        diagnostics={terminalDiagnostics('retry_exhausted')}
        onRetry={onRetry}
        status="disconnected"
      />,
    );

    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
    });
    await fireEvent.press(screen.getByLabelText('Retry live connection'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(['authentication_failed', 'invalid_configuration'] as const)(
    'does not offer a misleading retry for terminal reason %s',
    async (reason) => {
      await render(
        <ChatConnectionBanner
          diagnostics={terminalDiagnostics(reason)}
          onRetry={jest.fn()}
          status="disconnected"
        />,
      );
      await act(async () => {
        jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
      });
      expect(screen.queryByLabelText('Retry live connection')).toBeNull();
    },
  );

  it('resets its delay when the non-connected status changes', async () => {
    const view = await render(<ChatConnectionBanner status="reconnecting" />);
    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
    });
    expect(screen.getByTestId('chat-connection-banner')).toBeTruthy();

    await view.rerender(<ChatConnectionBanner status="disconnected" />);
    expect(screen.queryByTestId('chat-connection-banner')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_DELAY_MS);
    });
    expect(
      screen.getByText(
        'Live chat is disconnected. New messages may be delayed.',
      ),
    ).toBeTruthy();
  });
});
