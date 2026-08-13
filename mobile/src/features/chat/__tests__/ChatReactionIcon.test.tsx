import { render } from '@testing-library/react-native';
import { ALLOWED_REACTION_EMOJIS } from '../types';
import {
  ChatReactionIcon,
  REACTION_ICON_NAMES,
} from '../components/ChatReactionIcon';

const mockFontAwesome6 = jest.fn((_props: unknown) => null);

jest.mock('@expo/vector-icons', () => ({
  FontAwesome6: (props: unknown) => mockFontAwesome6(props),
}));

describe('ChatReactionIcon', () => {
  beforeEach(() => {
    mockFontAwesome6.mockClear();
  });

  it('maps every backend Unicode reaction to an app-bundled vector glyph', async () => {
    await render(
      <>
        {ALLOWED_REACTION_EMOJIS.map((emoji) => (
          <ChatReactionIcon emoji={emoji} key={emoji} />
        ))}
      </>,
    );

    expect(mockFontAwesome6).toHaveBeenCalledTimes(ALLOWED_REACTION_EMOJIS.length);
    const rendered = mockFontAwesome6.mock.calls.map(([props]) => props as {
      accessibilityElementsHidden: boolean;
      name: string;
      solid: boolean;
      testID: string;
    });
    expect(rendered.map(({ name }) => name)).toEqual(
      ALLOWED_REACTION_EMOJIS.map((emoji) => REACTION_ICON_NAMES[emoji]),
    );
    expect(rendered.every(({ solid }) => solid)).toBe(true);
    expect(rendered.every(({ accessibilityElementsHidden }) => accessibilityElementsHidden)).toBe(
      true,
    );
    expect(rendered.map(({ testID }) => testID)).toEqual(
      ALLOWED_REACTION_EMOJIS.map((emoji) => `chat-reaction-icon-${emoji}`),
    );
  });
});
