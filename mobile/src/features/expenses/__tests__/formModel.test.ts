import type { TripMember } from '@/features/trips/types';
import {
  buildContributionPayload,
  buildCreateExpensePayload,
  buildPatchExpensePayload,
  createExpenseDraft,
  getDepartedCurrentCollector,
  getEligibleCollectors,
  getExpenseDirtyFields,
  hydrateExpenseDraft,
  validateContributionAmount,
  validateExpenseDraft,
} from '../formModel';
import type {
  ExpenseDetailResponse,
  ExpenseParticipant,
} from '../types';

function buildMember(
  id: string,
  displayName = id,
): TripMember {
  return {
    membership_id: `membership-${id}`,
    user: {
      id,
      display_name: displayName,
      identify_tag: `@${id}`,
      avatar_url: null,
    },
    role: 'MEMBER',
    joined_at: '2026-07-28T00:00:00Z',
  };
}

function buildParticipant(
  userId: string,
): ExpenseParticipant {
  return {
    user_id: userId,
    display_name: userId,
    identify_tag: `@${userId}`,
    share_amount: '50.00',
    contributed_amount: '0.00',
    balance: '-50.00',
    surplus_held: '0.00',
  };
}

function buildDetail(
  overrides: Partial<ExpenseDetailResponse> = {},
): ExpenseDetailResponse {
  return {
    id: 'expense-1',
    title: 'Hotel',
    description: 'Deposit',
    total_amount: '100.00',
    paid_amount: '0.00',
    missing_amount: '100.00',
    surplus_amount: '0.00',
    currency_code: 'USD',
    status: 'UNDERFUNDED',
    collector: {
      id: 'collector-1',
      display_name: 'Collector',
      identify_tag: '@collector',
    },
    locked: false,
    locked_at: null,
    created_at: '2026-07-28T00:00:00Z',
    permissions: { can_manage_expenses: true },
    participants: [
      buildParticipant('collector-1'),
      buildParticipant('member-1'),
    ],
    ...overrides,
  };
}

describe('expense form drafts and validation', () => {
  it('creates a fresh draft and hydrates one immutable snapshot', () => {
    expect(createExpenseDraft('collector-1')).toEqual({
      title: '',
      description: '',
      total_amount: '',
      collector_id: 'collector-1',
    });

    const detail = buildDetail();
    const draft = hydrateExpenseDraft(detail);
    expect(draft).toEqual({
      title: 'Hotel',
      description: 'Deposit',
      total_amount: '100.00',
      collector_id: 'collector-1',
    });

    detail.title = 'Refreshed server title';
    detail.collector.id = 'other-collector';
    expect(draft.title).toBe('Hotel');
    expect(draft.collector_id).toBe('collector-1');
  });

  it('validates title, positive total, scale, and collector eligibility', () => {
    const invalid = validateExpenseDraft(
      {
        title: ' ',
        description: '',
        total_amount: '0',
        collector_id: 'outsider-1',
      },
      'USD',
      {
        mode: 'create',
        eligibleCollectorIds: ['member-1'],
      },
    );

    expect(invalid).toEqual({
      isValid: false,
      fieldErrors: {
        title: 'Title is required.',
        total_amount: 'Amount must be greater than zero.',
        collector_id: 'Choose an eligible active trip member.',
      },
    });

    expect(
      validateExpenseDraft(
        {
          title: '😀'.repeat(121),
          description: '',
          total_amount: '10.555',
          collector_id: null,
        },
        'USD',
      ).fieldErrors,
    ).toMatchObject({
      title: 'Title must be 120 characters or fewer.',
      total_amount: 'Invalid amount.',
    });
  });

  it('builds a canonical create payload without numeric money conversion', () => {
    expect(
      buildCreateExpensePayload(
        {
          title: '  Hotel deposit  ',
          description: '  First night  ',
          total_amount: '001,200.50',
          collector_id: 'member-1',
        },
        'USD',
        ['member-1'],
      ),
    ).toEqual({
      title: 'Hotel deposit',
      description: 'First night',
      total_amount: '1200.50',
      collector_id: 'member-1',
    });
  });

  it('omits an empty collector so the server can default it', () => {
    expect(
      buildCreateExpensePayload(
        {
          title: 'Dinner',
          description: '',
          total_amount: '600000',
          collector_id: null,
        },
        'VND',
      ),
    ).toEqual({
      title: 'Dinner',
      description: '',
      total_amount: '600000',
    });
  });
});

describe('minimal expense PATCH', () => {
  it('emits only canonical fields that are both dirty and changed', () => {
    const initial = hydrateExpenseDraft(buildDetail());
    const draft = {
      ...initial,
      title: '  New hotel  ',
      description: ' Deposit ',
      total_amount: '0100.00',
    };
    const dirtyFields = getExpenseDirtyFields(initial, draft);

    expect(dirtyFields).toEqual({
      title: true,
      description: true,
      total_amount: true,
    });
    expect(
      buildPatchExpensePayload(
        initial,
        draft,
        'USD',
        dirtyFields,
        ['collector-1', 'member-1'],
      ),
    ).toEqual({
      title: 'New hotel',
    });
  });

  it('omits an unchanged departed collector from PATCH', () => {
    const initial = hydrateExpenseDraft(
      buildDetail({
        collector: {
          id: 'departed-1',
          display_name: 'Departed collector',
          identify_tag: '@departed',
        },
      }),
    );
    const draft = { ...initial, title: 'Updated hotel' };

    expect(
      buildPatchExpensePayload(
        initial,
        draft,
        'USD',
        undefined,
        ['member-1'],
      ),
    ).toEqual({ title: 'Updated hotel' });
  });

  it('includes an explicitly selected eligible replacement collector', () => {
    const initial = hydrateExpenseDraft(
      buildDetail({
        collector: {
          id: 'departed-1',
          display_name: 'Departed collector',
          identify_tag: '@departed',
        },
      }),
    );

    expect(
      buildPatchExpensePayload(
        initial,
        { ...initial, collector_id: 'member-1' },
        'USD',
        undefined,
        ['member-1'],
      ),
    ).toEqual({ collector_id: 'member-1' });
  });

  it('rejects an ineligible replacement and an empty edit collector', () => {
    const initial = hydrateExpenseDraft(buildDetail());

    expect(
      buildPatchExpensePayload(
        initial,
        { ...initial, collector_id: 'late-member' },
        'USD',
        undefined,
        ['member-1'],
      ),
    ).toBeNull();
    expect(
      buildPatchExpensePayload(
        initial,
        { ...initial, collector_id: null },
        'USD',
      ),
    ).toBeNull();
  });
});

describe('collector eligibility', () => {
  const activeMembers = [
    buildMember('collector-1', 'Collector'),
    buildMember('member-1', 'Member'),
    buildMember('late-member', 'Late member'),
  ];

  it('uses every active member for create', () => {
    expect(
      getEligibleCollectors(activeMembers).map((member) => member.user.id),
    ).toEqual(['collector-1', 'member-1', 'late-member']);
  });

  it('intersects active members with the immutable participant snapshot for edit', () => {
    expect(
      getEligibleCollectors(activeMembers, [
        buildParticipant('collector-1'),
        buildParticipant('member-1'),
        buildParticipant('departed-1'),
      ]).map((member) => member.user.id),
    ).toEqual(['collector-1', 'member-1']);
  });

  it('returns a departed current collector only for display, never as an option', () => {
    const departed = {
      id: 'departed-1',
      display_name: 'Departed collector',
      identify_tag: '@departed',
    };
    const eligible = getEligibleCollectors(activeMembers, [
      buildParticipant('departed-1'),
      buildParticipant('member-1'),
    ]);

    expect(eligible.map((member) => member.user.id)).toEqual(['member-1']);
    expect(getDepartedCurrentCollector(departed, eligible)).toBe(departed);
    expect(
      getDepartedCurrentCollector(
        {
          id: 'member-1',
          display_name: 'Member',
          identify_tag: '@member',
        },
        eligible,
      ),
    ).toBeNull();
  });
});

describe('contribution payload', () => {
  it('accepts zero and overfunding as canonical strings', () => {
    expect(buildContributionPayload('0', 'VND')).toEqual({ amount: '0' });
    expect(
      buildContributionPayload('999999999999.99', 'USD'),
    ).toEqual({
      amount: '999999999999.99',
    });
  });

  it('rejects negative, excess-scale, and max-digit violations', () => {
    expect(buildContributionPayload('-1', 'USD')).toBeNull();
    expect(buildContributionPayload('10.555', 'USD')).toBeNull();
    expect(buildContributionPayload('9999999999999', 'VND')).toBeNull();
    expect(validateContributionAmount('', 'USD').error).toBe(
      'Amount is required.',
    );
  });
});
