import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { colors } from '@/shared/theme/tokens';
import {
  CHAT_CONNECTION_BANNER_DELAY_MS,
  CHAT_CONNECTION_BANNER_ESCALATION_MS,
  ChatConnectionBanner,
} from '../components/ChatConnectionBanner';

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
    const banner = screen.getByTestId('chat-connection-banner');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(banner.props.children).toContain('Reconnecting');
  });

  it('escalates a sustained disconnection without changing the truthful copy', async () => {
    await render(<ChatConnectionBanner status="disconnected" />);

    await act(async () => {
      jest.advanceTimersByTime(CHAT_CONNECTION_BANNER_ESCALATION_MS);
    });
    const banner = screen.getByTestId('chat-connection-banner');
    expect(banner.props.children).toBe('Disconnected. Trying again shortly.');
    expect(StyleSheet.flatten(banner.props.style).backgroundColor).toBe(colors.warningSoft);
  });

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
    expect(screen.getByText('Disconnected. Trying again shortly.')).toBeTruthy();
  });
});
