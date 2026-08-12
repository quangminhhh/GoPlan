import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatComposer,
  type ChatComposerSubmitResult,
} from '../components/ChatComposer';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const cleared: ChatComposerSubmitResult = {
  draftDisposition: 'clear',
  feedback: null,
};

interface TestFiber {
  memoizedProps?: { onPress?: () => void };
  return: TestFiber | null;
}

function synchronousPressHandler(node: unknown): () => void {
  let fiber = (node as { unstable_fiber?: TestFiber }).unstable_fiber ?? null;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onPress === 'function') {
      return fiber.memoizedProps.onPress;
    }
    fiber = fiber.return;
  }
  throw new Error('Expected the rendered Send control to expose an onPress handler.');
}

describe('ChatComposer', () => {
  it('uses a multiline 2,000-character field and disables whitespace-only sends', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);

    const input = screen.getByLabelText('Message');
    const send = screen.getByLabelText('Send message');
    expect(input.props.multiline).toBe(true);
    expect(input.props.maxLength).toBe(CHAT_MESSAGE_MAX_LENGTH);
    expect(send.props.accessibilityState.disabled).toBe(true);

    await fireEvent.changeText(input, '   ');
    expect(screen.getByLabelText('Send message').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims the submitted value and clears the composer when instructed', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);

    await fireEvent.changeText(screen.getByLabelText('Message'), '  Hello team  ');
    await fireEvent.press(screen.getByLabelText('Send message'));

    expect(onSubmit).toHaveBeenCalledWith('Hello team');
    await waitFor(() => {
      expect(screen.getByLabelText('Message').props.value).toBe('');
    });
  });

  it('restores the exact local draft and announces backend feedback for a blocked send', async () => {
    const onSubmit = jest.fn(async (): Promise<ChatComposerSubmitResult> => ({
      draftDisposition: 'preserve',
      feedback: 'Too many messages. Try again in 30 seconds.',
    }));
    await render(<ChatComposer onSubmit={onSubmit} />);

    await fireEvent.changeText(screen.getByLabelText('Message'), '  Keep my spacing  ');
    await fireEvent.press(screen.getByLabelText('Send message'));

    expect(onSubmit).toHaveBeenCalledWith('Keep my spacing');
    const feedback = await screen.findByTestId('chat-composer-feedback');
    expect(screen.getByLabelText('Message').props.value).toBe('  Keep my spacing  ');
    expect(feedback.props.accessibilityRole).toBe('alert');
    expect(feedback.props.accessibilityLiveRegion).toBe('polite');
    expect(feedback.props.children).toBe('Too many messages. Try again in 30 seconds.');
  });

  it('clears stale blocked feedback when the user edits the draft', async () => {
    const onSubmit = jest.fn(async (): Promise<ChatComposerSubmitResult> => ({
      draftDisposition: 'preserve',
      feedback: 'Please wait before sending again.',
    }));
    await render(<ChatComposer onSubmit={onSubmit} />);

    await fireEvent.changeText(screen.getByLabelText('Message'), 'Hello');
    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(await screen.findByText('Please wait before sending again.')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Message'), 'Hello again');
    expect(screen.queryByText('Please wait before sending again.')).toBeNull();
  });

  it('exposes disabled and busy states without accepting duplicate submits', async () => {
    let resolveSubmit: ((value: ChatComposerSubmitResult) => void) | undefined;
    const onSubmit = jest.fn(
      () =>
        new Promise<ChatComposerSubmitResult>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    await render(<ChatComposer onSubmit={onSubmit} />);

    await fireEvent.changeText(screen.getByLabelText('Message'), 'One message');
    const initialSend = screen.getByLabelText('Send message');
    const pressSend = synchronousPressHandler(initialSend);
    await act(async () => {
      pressSend();
      pressSend();
    });

    const busySend = screen.getByLabelText('Send message');
    expect(busySend.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(screen.getByLabelText('Message').props.editable).toBe(false);
    await fireEvent.press(busySend);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSubmit?.(cleared);
    });
  });
});
