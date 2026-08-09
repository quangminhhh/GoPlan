import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactionSummary } from '../types';
import { ChatReactionBar } from '../components/ChatReactionBar';

const viewerId = 'user-me';

function reaction(
  emoji: ReactionSummary['emoji'],
  count: number,
  reactedByIds: readonly string[] = [],
): ReactionSummary {
  return { emoji, count, reacted_by_ids: reactedByIds };
}

describe('ChatReactionBar', () => {
  it('renders unordered server summaries in the canonical seven-emoji order', async () => {
    await render(
      <ChatReactionBar
        currentUserId={viewerId}
        reactions={[
          reaction('👎', 1),
          reaction('😂', 2),
          reaction('❤️', 3),
          reaction('😡', 4),
          reaction('👍', 5),
          reaction('😢', 6),
          reaction('😮', 7),
        ]}
      />,
    );

    const labels = screen.getAllByLabelText(/reaction/).map((node) => node.props.accessibilityLabel);
    expect(labels).toEqual([
      'Heart, 3 reactions',
      'Face with tears of joy, 2 reactions',
      'Surprised face, 7 reactions',
      'Crying face, 6 reactions',
      'Angry face, 4 reactions',
      'Thumbs up, 5 reactions',
      'Thumbs down, 1 reaction',
    ]);
  });

  it('derives reacted-by-me from ids and toggles the exact emoji', async () => {
    const onToggle = jest.fn();
    await render(
      <ChatReactionBar
        currentUserId={viewerId}
        reactions={[reaction('👍', 2, [viewerId, 'user-other'])]}
        onToggle={onToggle}
      />,
    );

    const chip = screen.getByLabelText('Thumbs up, 2 reactions, you reacted');
    expect(chip.props.accessibilityState.selected).toBe(true);
    expect(chip.props.accessibilityHint).toBe('Removes your reaction');
    await fireEvent.press(chip);
    expect(onToggle).toHaveBeenCalledWith('👍');
  });

  it('renders terminal/read-only reaction summaries as text, not mutation controls', async () => {
    await render(
      <ChatReactionBar
        currentUserId={viewerId}
        reactions={[reaction('❤️', 1)]}
        disabled
        onToggle={() => undefined}
      />,
    );

    const summary = screen.getByLabelText('Heart, 1 reaction');
    expect(summary.props.accessibilityRole).toBeUndefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('marks an in-flight mutation busy and blocks repeat toggles', async () => {
    const onToggle = jest.fn();
    await render(
      <ChatReactionBar
        currentUserId={viewerId}
        reactions={[reaction('😮', 2)]}
        busy
        onToggle={onToggle}
      />,
    );

    const chip = screen.getByLabelText('Surprised face, 2 reactions');
    expect(chip.props.accessibilityState).toEqual({
      selected: false,
      disabled: true,
      busy: true,
    });
    await fireEvent.press(chip);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('omits empty and zero-count summaries', async () => {
    const view = await render(
      <ChatReactionBar currentUserId={viewerId} reactions={[]} />,
    );
    expect(screen.queryByTestId('chat-reaction-bar')).toBeNull();

    await view.rerender(
      <ChatReactionBar currentUserId={viewerId} reactions={[reaction('😢', 0)]} />,
    );
    expect(screen.queryByTestId('chat-reaction-bar')).toBeNull();
  });
});
