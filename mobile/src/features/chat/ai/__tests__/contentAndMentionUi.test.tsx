import {
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { AIMessageContent } from '../components/AIMessageContent';
import { AITypingIndicator } from '../components/AITypingIndicator';
import {
  GoPlanAIComposerIntent,
  GoPlanAIMentionCommandMenu,
  GoPlanAIMentionMessageText,
} from '../components/AIMention';
import { parseConstrainedAIText } from '../constrainedText';

describe('constrained untrusted AI text', () => {
  it('parses only allowlisted headings, lists, inline code, emphasis, and fences', () => {
    expect(
      parseConstrainedAIText(
        '# Plan\n- Visit `museum`\n1. **Book** tickets\n```bash\npnpm test\n```',
      ),
    ).toEqual([
      {
        kind: 'heading',
        level: 1,
        segments: [{ kind: 'text', text: 'Plan' }],
      },
      {
        kind: 'list_item',
        ordered: false,
        ordinal: null,
        segments: [
          { kind: 'text', text: 'Visit ' },
          { kind: 'code', text: 'museum' },
        ],
      },
      {
        kind: 'list_item',
        ordered: true,
        ordinal: 1,
        segments: [{ kind: 'strong', text: 'Book' }, { kind: 'text', text: ' tickets' }],
      },
      { kind: 'code_block', language: 'bash', code: 'pnpm test' },
    ]);
  });

  it('renders HTML, markdown links, images, and script text inertly with no link/action role', async () => {
    const content =
      '<script>doTripMutation()</script> [Open trip](https://evil.example) ![pixel](https://evil.example/p.png)';
    await render(<AIMessageContent content={content} />);
    expect(screen.getByText(/doTripMutation/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/evil\.example/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders fenced code as selectable text in horizontal scroll without evaluating it', async () => {
    await render(
      <AIMessageContent content={'```javascript\neval("danger")\n```'} />,
    );
    const scroller = screen.getByLabelText('javascript code block');
    expect(scroller.props.horizontal).toBe(true);
    const code = screen.getByText('eval("danger")');
    expect(code.props.selectable).toBe(true);
  });
});

describe('GoPlanAI mention and typing primitives', () => {
  it('renders a distinct inert token in normalized sent content', async () => {
    await render(<GoPlanAIMentionMessageText content="plan day 1 @GoPlanAI" />);
    expect(screen.getByLabelText('GoPlanAI mention')).toBeTruthy();
    expect(screen.getByText(' plan day 1')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers an accessible 44pt command item and inserts through one callback', async () => {
    const onSelect = jest.fn();
    await render(
      <GoPlanAIMentionCommandMenu open onSelect={onSelect} />,
    );
    const item = screen.getByRole('button', { name: 'Mention GoPlanAI' });
    expect(StyleSheet.flatten(item.props.style)).toMatchObject({ minHeight: 44 });
    await fireEvent.press(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('makes quota intent visible before send and exposes correlated typing identity', async () => {
    await render(
      <>
        <GoPlanAIComposerIntent />
        <AITypingIndicator interactionId="interaction-7" />
      </>,
    );
    expect(screen.getByText(/20 prompts\/hour/)).toBeTruthy();
    expect(screen.getByTestId('goplan-ai-typing-interaction-7')).toBeTruthy();
    expect(screen.getByLabelText('GoPlanAI is replying').props.accessibilityLiveRegion).toBe(
      'polite',
    );
  });
});
