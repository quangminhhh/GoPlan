export const GOPLAN_AI_MENTION = '@GoPlanAI';
export const GOPLAN_AI_PROMPT_LIMIT_PER_HOUR = 20;
export const GOPLAN_AI_RATE_LIMIT_MESSAGE =
  'GoPlanAI allows 20 prompts per hour. Your prompt was not sent; try again later.';

const GOPLAN_AI_PATTERN = /@GoPlanAI\b/gi;
const TRAILING_COMMAND_TRIGGER_PATTERN = /@\s*$/;

export interface GoPlanAIMentionParseResult {
  readonly hasMention: boolean;
  readonly prompt: string;
  readonly displayContent: string;
}

/** Kept byte-for-byte equivalent to the web parser contract. */
export function parseGoPlanAIMention(
  value: string,
): GoPlanAIMentionParseResult {
  const hasMention = GOPLAN_AI_PATTERN.test(value);
  GOPLAN_AI_PATTERN.lastIndex = 0;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!hasMention) {
    return { hasMention: false, prompt: normalized, displayContent: normalized };
  }
  const prompt = value
    .replace(GOPLAN_AI_PATTERN, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return {
    hasMention: true,
    prompt,
    displayContent: prompt ? `${GOPLAN_AI_MENTION} ${prompt}` : GOPLAN_AI_MENTION,
  };
}

export function shouldOfferGoPlanAICommand(value: string): boolean {
  return /(^|\s)@$/.test(value);
}

export function insertGoPlanAIMention(value: string): GoPlanAIMentionParseResult {
  const prompt = value.replace(TRAILING_COMMAND_TRIGGER_PATTERN, '').trim();
  return parseGoPlanAIMention(
    prompt.length > 0 ? `${GOPLAN_AI_MENTION} ${prompt}` : GOPLAN_AI_MENTION,
  );
}

export type GoPlanAIMessageSegment =
  | { readonly kind: 'mention'; readonly text: typeof GOPLAN_AI_MENTION }
  | { readonly kind: 'text'; readonly text: string };

/**
 * Returns display-only segments. A mention segment has no callback or URL, so
 * server-rewritten content can be styled without becoming an executable token.
 */
export function tokenizeGoPlanAIMention(
  content: string,
): readonly GoPlanAIMessageSegment[] {
  const parsed = parseGoPlanAIMention(content);
  if (!parsed.hasMention) {
    return parsed.displayContent
      ? [{ kind: 'text', text: parsed.displayContent }]
      : [];
  }
  return parsed.prompt
    ? [
        { kind: 'mention', text: GOPLAN_AI_MENTION },
        { kind: 'text', text: ` ${parsed.prompt}` },
      ]
    : [{ kind: 'mention', text: GOPLAN_AI_MENTION }];
}

export function isGoPlanAIThrottledSend(
  content: string,
  status: number | null,
): boolean {
  return status === 429 && parseGoPlanAIMention(content).hasMention;
}

export function goPlanAISendFailureMessage(
  content: string,
  failure: { readonly status: number | null; readonly message: string },
): string {
  return isGoPlanAIThrottledSend(content, failure.status)
    ? GOPLAN_AI_RATE_LIMIT_MESSAGE
    : failure.message;
}
