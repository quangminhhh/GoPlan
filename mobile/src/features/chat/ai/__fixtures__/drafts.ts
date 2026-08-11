import { requireAIActionDraft, type AIActionDraft } from '../drafts';

export function makeRawDraftFixture(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    action_type: 'expense.create',
    status: 'READY',
    required_confirmation: 'CAPTAIN',
    can_confirm: true,
    can_cancel: true,
    can_edit: false,
    display: {
      icon: 'expense',
      tone: 'create',
      kicker: 'Expense',
      title: 'Dinner',
      hero: { kind: 'amount', value: '1,200,000', currency: 'VND' },
      meta: [{ label: 'Collector', value: 'Lan' }],
    },
    summary: 'Create dinner expense',
    preview: {
      title: 'Dinner',
      total_amount: '1200000',
      currency_code: 'VND',
      collector_name: 'Lan',
    },
    missing_fields: [],
    result: {},
    error_code: '',
    error_detail: '',
    expires_at: '2099-06-01T00:00:00.000Z',
    created_at: '2026-05-13T00:00:00.000Z',
    updated_at: '2026-05-13T00:00:00.000Z',
    ...overrides,
  };
}

export function makeDraftFixture(
  overrides: Readonly<Record<string, unknown>> = {},
): AIActionDraft {
  return requireAIActionDraft(makeRawDraftFixture(overrides));
}
