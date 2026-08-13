import {
  AI_ACTION_DRAFT_STATUSES,
  parseAIActionDraft,
  requireAIActionDraftEnvelope,
} from '../drafts';
import { makeRawDraftFixture as makeRawDraft } from '../__fixtures__/drafts';

describe('AI action draft runtime contract', () => {
  it('contains exactly the six backend statuses and never EXECUTED', () => {
    expect(AI_ACTION_DRAFT_STATUSES).toEqual([
      'NEEDS_INFO',
      'READY',
      'CONFIRMED',
      'CANCELLED',
      'EXPIRED',
      'FAILED',
    ]);
    expect(parseAIActionDraft(makeRawDraft({ status: 'EXECUTED' }))).toBeNull();
  });

  it.each(AI_ACTION_DRAFT_STATUSES)('accepts status %s', (status) => {
    expect(parseAIActionDraft(makeRawDraft({ status }))?.status).toBe(status);
  });

  it('preserves unknown action, confirmation, display, preview, and top-level values', () => {
    const draft = parseAIActionDraft(
      makeRawDraft({
        action_type: 'future.action.teleport',
        required_confirmation: 'FUTURE_AUTHORITY',
        display: { title: 'Teleport', future_hint: { color: 'ultraviolet' } },
        preview: { destination: { planet: 'Mars' } },
        future_top_level: { retained: true },
      }),
    );
    expect(draft).not.toBeNull();
    expect(draft?.action_type).toBe('future.action.teleport');
    expect(draft?.required_confirmation).toBe('FUTURE_AUTHORITY');
    expect(draft?.display.future_hint).toEqual({ color: 'ultraviolet' });
    expect(draft?.preview.destination).toEqual({ planet: 'Mars' });
    expect(draft?.future_top_level).toEqual({ retained: true });
  });

  it('canonicalizes a valid draft UUID and rejects unusable ids', () => {
    expect(
      parseAIActionDraft(
        makeRawDraft({ id: ' 22222222-2222-4222-8222-22222222222A ' }),
      )?.id,
    ).toBe('22222222-2222-4222-8222-22222222222a');
    expect(parseAIActionDraft(makeRawDraft({ id: 'draft-1' }))).toBeNull();
  });

  it('preserves enriched missing-field extensions while validating known shapes', () => {
    const draft = parseAIActionDraft(
      makeRawDraft({
        missing_fields: [
          {
            name: 'section_id',
            label: 'Timeline day',
            type: 'select',
            required: true,
            constraints: { future_rule: 'keep-me' },
            options: [{ label: 'Day 1', value: 'section-1', future: 1 }],
            presets: [{ label: 'Morning', start: '08:00', end: '10:00' }],
            future_field_hint: 'retained',
          },
        ],
      }),
    );
    expect(draft?.missing_fields[0].future_field_hint).toBe('retained');
    expect(draft?.missing_fields[0].constraints?.future_rule).toBe('keep-me');
    expect(draft?.missing_fields[0].options?.[0].future).toBe(1);
  });

  it.each([
    ['missing id', { id: '' }],
    ['unknown status', { status: 'PENDING' }],
    ['non-boolean authority', { can_confirm: 'yes' }],
    ['array display', { display: [] }],
    ['non-record preview', { preview: 'bad' }],
    ['non-list missing fields', { missing_fields: {} }],
    ['duplicate missing field', {
      missing_fields: [
        { name: 'title', label: 'Title' },
        { name: 'title', label: 'Again' },
      ],
    }],
    ['malformed option', {
      missing_fields: [
        { name: 'status', label: 'Status', options: [{ label: 'Done' }] },
      ],
    }],
    ['invalid expiry', { expires_at: 'tomorrow-ish' }],
  ])('rejects malformed payload: %s', (_label, overrides) => {
    expect(parseAIActionDraft(makeRawDraft(overrides))).toBeNull();
  });

  it('strictly requires the success envelope', () => {
    expect(requireAIActionDraftEnvelope({ draft: makeRawDraft() }).draft.id).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(() => requireAIActionDraftEnvelope({ payload: makeRawDraft() })).toThrow(
      'invalid response',
    );
  });
});
