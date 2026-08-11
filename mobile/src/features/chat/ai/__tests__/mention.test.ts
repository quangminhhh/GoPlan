import {
  GOPLAN_AI_MENTION,
  GOPLAN_AI_RATE_LIMIT_MESSAGE,
  goPlanAISendFailureMessage,
  insertGoPlanAIMention,
  isGoPlanAIThrottledSend,
  parseGoPlanAIMention,
  shouldOfferGoPlanAICommand,
  tokenizeGoPlanAIMention,
} from '../mention';

describe('GoPlanAI mention contract', () => {
  it.each([
    {
      value: 'hello team',
      expected: {
        hasMention: false,
        prompt: 'hello team',
        displayContent: 'hello team',
      },
    },
    {
      value: 'plan day 1 @GoPlanAI',
      expected: {
        hasMention: true,
        prompt: 'plan day 1',
        displayContent: '@GoPlanAI plan day 1',
      },
    },
    {
      value: '@GoPlanAI',
      expected: {
        hasMention: true,
        prompt: '',
        displayContent: '@GoPlanAI',
      },
    },
  ])('ports the web parser case for "$value"', ({ value, expected }) => {
    expect(parseGoPlanAIMention(value)).toEqual(expected);
  });

  it('is case-insensitive, respects the word boundary, removes all mentions, and collapses whitespace', () => {
    expect(
      parseGoPlanAIMention('  @goplanai\n plan   @GoPlanAI day 1  '),
    ).toEqual({
      hasMention: true,
      prompt: 'plan day 1',
      displayContent: '@GoPlanAI plan day 1',
    });
    expect(parseGoPlanAIMention('@GoPlanAIx plan').hasMention).toBe(false);
  });

  it('offers only a trailing command trigger and inserts the exact literal', () => {
    expect(shouldOfferGoPlanAICommand('hello @')).toBe(true);
    expect(shouldOfferGoPlanAICommand('hello @g')).toBe(false);
    const inserted = insertGoPlanAIMention('plan day 1 @');
    expect(inserted.displayContent).toBe(`${GOPLAN_AI_MENTION} plan day 1`);
  });

  it('returns inert mention/text segments and detects only AI throttles', () => {
    expect(tokenizeGoPlanAIMention('plan @GoPlanAI')).toEqual([
      { kind: 'mention', text: '@GoPlanAI' },
      { kind: 'text', text: ' plan' },
    ]);
    expect(isGoPlanAIThrottledSend('@GoPlanAI help', 429)).toBe(true);
    expect(isGoPlanAIThrottledSend('hello', 429)).toBe(false);
    expect(isGoPlanAIThrottledSend('@GoPlanAI help', 409)).toBe(false);
    expect(
      goPlanAISendFailureMessage('@GoPlanAI help', {
        status: 429,
        message: 'Generic throttle.',
      }),
    ).toBe(GOPLAN_AI_RATE_LIMIT_MESSAGE);
    expect(
      goPlanAISendFailureMessage('hello', {
        status: 429,
        message: 'Ordinary chat limit.',
      }),
    ).toBe('Ordinary chat limit.');
  });
});
