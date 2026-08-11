import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
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

  it('offers a trailing-at command and inserts the exact GoPlanAI mention while retaining focus', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);

    const input = screen.getByLabelText('Message');
    await fireEvent.changeText(input, 'plan day 1 @');
    expect(screen.getByLabelText('Mention suggestions')).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'Mention GoPlanAI' }),
    );

    expect(screen.getByLabelText('Message').props.value).toBe(
      '@GoPlanAI plan day 1',
    );
    expect(screen.queryByLabelText('Mention suggestions')).toBeNull();
    expect(screen.getByTestId('goplan-ai-composer-intent')).toBeTruthy();
  });

  it('shows AI quota intent for any case-insensitive mention and trims only the outer whitespace', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);

    const typed = '  @goplanai Keep  internal\nspacing  ';
    await fireEvent.changeText(screen.getByLabelText('Message'), typed);
    expect(screen.getByText(/20 prompts\/hour/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Send message'));

    expect(onSubmit).toHaveBeenCalledWith(
      '@goplanai Keep  internal\nspacing',
    );
  });

  it('renders a distinct inert GoPlanAI token inside the active composer intent only', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);

    expect(screen.queryByTestId('goplan-ai-composer-intent')).toBeNull();
    expect(screen.queryByTestId('goplan-ai-mention-token')).toBeNull();

    await fireEvent.changeText(
      screen.getByLabelText('Message'),
      '@goplanai plan the morning',
    );

    const intent = screen.getByTestId('goplan-ai-composer-intent');
    expect(within(intent).getByTestId('goplan-ai-mention-token')).toBeTruthy();
    expect(within(intent).queryByRole('button')).toBeNull();
    expect(within(intent).queryByRole('link')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('Message'), 'ordinary draft');
    expect(screen.queryByTestId('goplan-ai-composer-intent')).toBeNull();
    expect(screen.queryByTestId('goplan-ai-mention-token')).toBeNull();
  });

  it('blocks a bare GoPlanAI mention locally with a useful hint and zero submit', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);

    await fireEvent.changeText(
      screen.getByLabelText('Message'),
      '  @GoPlanAI\n  ',
    );

    const send = screen.getByLabelText('Send message');
    expect(send.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('goplan-ai-prompt-hint')).toHaveTextContent(
      'Add a prompt for GoPlanAI before sending.',
    );
    await fireEvent.press(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('inserts an exact 2,000-character AI command but never truncates an overflowing draft', async () => {
    const onSubmit = jest.fn(async () => cleared);
    await render(<ChatComposer onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Message');
    const overflowingDraft = `${'a'.repeat(1991)} @`;

    await fireEvent.changeText(input, overflowingDraft);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Mention GoPlanAI' }),
    );
    expect(screen.getByLabelText('Message').props.value).toBe(
      overflowingDraft,
    );
    expect(screen.getByTestId('chat-composer-feedback')).toHaveTextContent(
      'GoPlanAI mention cannot be inserted because this message would exceed 2,000 characters.',
    );

    await fireEvent.changeText(input, `${'a'.repeat(1990)} @`);
    await fireEvent.press(
      screen.getByRole('button', { name: 'Mention GoPlanAI' }),
    );
    const inserted = screen.getByLabelText('Message').props.value as string;
    expect(inserted).toHaveLength(CHAT_MESSAGE_MAX_LENGTH);
    expect(inserted.startsWith('@GoPlanAI ')).toBe(true);
    expect(screen.queryByTestId('chat-composer-feedback')).toBeNull();
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
