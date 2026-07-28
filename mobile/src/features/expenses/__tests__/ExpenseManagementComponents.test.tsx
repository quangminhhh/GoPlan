const mockIonicons = jest.fn((_props: unknown) => null);

jest.mock('@expo/vector-icons', () => ({
  Ionicons: (props: unknown) => mockIonicons(props),
}));

// eslint-disable-next-line import/first
import {
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { ContributionEditor } from '../components/ContributionEditor';
// eslint-disable-next-line import/first
import { ExpenseForm } from '../components/ExpenseForm';
// eslint-disable-next-line import/first
import type {
  ExpenseFormDraft,
  ExpenseFormFieldErrors,
} from '../formModel';
// eslint-disable-next-line import/first
import type { ExpenseParticipant } from '../types';
// eslint-disable-next-line import/first
import type { TripMember } from '@/features/trips/types';

function buildParticipant(
  overrides: Partial<ExpenseParticipant> = {},
): ExpenseParticipant {
  return {
    user_id: 'user-1',
    display_name: 'An Nguyen',
    identify_tag: 'an#1200',
    share_amount: '25.00',
    contributed_amount: '40.00',
    balance: '15.00',
    surplus_held: '3.00',
    ...overrides,
  };
}

function buildMember(
  id: string,
  displayName: string,
): TripMember {
  return {
    membership_id: `membership-${id}`,
    user: {
      id,
      display_name: displayName,
      identify_tag: `${displayName.toLowerCase()}#1000`,
      avatar_url: null,
    },
    role: 'MEMBER',
    joined_at: '2026-07-28T00:00:00Z',
  };
}

function buildDraft(
  overrides: Partial<ExpenseFormDraft> = {},
): ExpenseFormDraft {
  return {
    title: '',
    description: '',
    total_amount: '',
    collector_id: null,
    ...overrides,
  };
}

function renderExpenseForm(
  overrides: Partial<React.ComponentProps<typeof ExpenseForm>> = {},
) {
  const props: React.ComponentProps<typeof ExpenseForm> = {
    mode: 'create',
    draft: buildDraft(),
    fieldErrors: {} as ExpenseFormFieldErrors,
    submitError: null,
    collectors: [
      buildMember('user-1', 'An'),
      buildMember('user-2', 'Binh'),
    ],
    currencyCode: 'USD',
    canSubmit: true,
    dirty: true,
    submitting: false,
    onChange: jest.fn(),
    onSubmit: jest.fn(),
    ...overrides,
  };
  return { props, view: render(<ExpenseForm {...props} />) };
}

describe('ContributionEditor', () => {
  it('is one virtualizable participant row and gates editing from server-owned actions', async () => {
    const onStartEditing = jest.fn();
    const rendered = await render(
      <ContributionEditor
        participant={buildParticipant()}
        currencyCode="USD"
        canEdit={false}
        isEditing={false}
        draftAmount=""
        onStartEditing={onStartEditing}
        onDraftChange={jest.fn()}
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByText('An Nguyen')).toBeTruthy();
    expect(screen.getByText('$25.00')).toBeTruthy();
    expect(screen.getByText('$40.00')).toBeTruthy();
    expect(screen.getByText('Overpaid')).toBeTruthy();
    expect(screen.getByText('+$15.00')).toBeTruthy();
    expect(screen.getByText('$3.00')).toBeTruthy();
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();

    await rendered.rerender(
      <ContributionEditor
        participant={buildParticipant()}
        currencyCode="USD"
        canEdit
        isEditing={false}
        draftAmount=""
        onStartEditing={onStartEditing}
        onDraftChange={jest.fn()}
        onSubmit={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Edit contribution for An Nguyen',
      }),
    );
    expect(onStartEditing).toHaveBeenCalledWith('user-1');
  });

  it('forwards canonical text and stable ids to screen-owned draft/actions', async () => {
    const onDraftChange = jest.fn();
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    await render(
      <ContributionEditor
        participant={buildParticipant()}
        currencyCode="USD"
        canEdit
        isEditing
        draftAmount="40.00"
        amountError="Amount has too many digits."
        error="Contribution changed in another session."
        onStartEditing={jest.fn()}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText('Contribution amount for An Nguyen'),
      '1,234.50',
    );
    expect(onDraftChange).toHaveBeenCalledWith(
      'user-1',
      '1,234.50',
    );
    expect(
      screen.getByText('Amount has too many digits.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Contribution changed in another session.',
      ),
    ).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Save contribution for An Nguyen',
      }),
    );
    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Cancel contribution edit for An Nguyen',
      }),
    );
    expect(onSubmit).toHaveBeenCalledWith('user-1');
    expect(onCancel).toHaveBeenCalledWith('user-1');
  });

  it('matches the contribution keyboard to the currency scale', async () => {
    const props = {
      participant: buildParticipant(),
      canEdit: true,
      isEditing: true,
      draftAmount: '40',
      onStartEditing: jest.fn(),
      onDraftChange: jest.fn(),
      onSubmit: jest.fn(),
      onCancel: jest.fn(),
    };
    const rendered = await render(
      <ContributionEditor {...props} currencyCode="USD" />,
    );

    expect(
      screen.getByLabelText(
        'Contribution amount for An Nguyen',
      ).props.keyboardType,
    ).toBe('decimal-pad');

    await rendered.rerender(
      <ContributionEditor {...props} currencyCode="VND" />,
    );
    expect(
      screen.getByLabelText(
        'Contribution amount for An Nguyen',
      ).props.keyboardType,
    ).toBe('number-pad');
  });

  it('uses a per-row loading lock for both editor actions', async () => {
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    await render(
      <ContributionEditor
        participant={buildParticipant()}
        currencyCode="USD"
        canEdit
        isEditing
        draftAmount="40.00"
        loading
        onStartEditing={jest.fn()}
        onDraftChange={jest.fn()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    const save = screen.getByRole('button', {
      name: 'Save contribution for An Nguyen',
    });
    const cancel = screen.getByRole('button', {
      name: 'Cancel contribution edit for An Nguyen',
    });
    expect(save.props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    expect(cancel.props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(save);
    await fireEvent.press(cancel);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ExpenseForm', () => {
  it('keeps raw canonical input controlled and virtualizes collector options horizontally', async () => {
    const onChange = jest.fn();
    await renderExpenseForm({ onChange }).view;

    const collectorList = screen.getByTestId(
      'expense-collector-list',
    );
    expect(collectorList.props.horizontal).toBe(true);
    expect(collectorList.props.data).toHaveLength(2);
    expect(
      screen.getByRole('button', {
        name: 'Use expense creator as collector',
      }).props.accessibilityState,
    ).toMatchObject({ selected: true });

    await fireEvent.changeText(
      screen.getByLabelText('Expense total amount'),
      '1,234.50',
    );
    expect(onChange).toHaveBeenCalledWith({
      total_amount: '1,234.50',
    });

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Choose Binh as collector',
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      collector_id: 'user-2',
    });
  });

  it('uses a zero-decimal keyboard for VND without changing the draft string', async () => {
    await renderExpenseForm({
      currencyCode: 'vnd',
      draft: buildDraft({ total_amount: '50000' }),
    }).view;

    expect(
      screen.getByLabelText('Expense total amount').props.keyboardType,
    ).toBe('number-pad');
    expect(screen.getByText('VND')).toBeTruthy();
  });

  it('shows a departed current collector as display-only and keeps eligible options virtualized', async () => {
    const onChange = jest.fn();
    await renderExpenseForm({
      mode: 'edit',
      draft: buildDraft({
        title: 'Beach house',
        total_amount: '300.00',
        collector_id: 'departed-1',
      }),
      currentCollector: {
        id: 'departed-1',
        display_name: 'Former Member',
        identify_tag: 'former#9090',
      },
      collectors: [buildMember('user-2', 'Binh')],
      dirty: true,
      onChange,
    }).view;

    expect(
      screen.getByLabelText(
        'Former Member, current collector, left trip',
      ),
    ).toBeTruthy();
    expect(screen.getByText('former#9090 · left trip')).toBeTruthy();
    expect(
      screen.getByTestId('expense-collector-list').props.data,
    ).toHaveLength(1);

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Choose Binh as collector',
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      collector_id: 'user-2',
    });
  });

  it('merges field errors, exposes pull-refresh, and retries background failure', async () => {
    const onRefresh = jest.fn();
    const onRetryBackground = jest.fn();
    await renderExpenseForm({
      fieldErrors: {
        title: 'Enter an expense name.',
      } as ExpenseFormFieldErrors,
      submitError: {
        kind: 'field',
        message: 'Fix the highlighted fields.',
        fieldErrors: {
          total_amount: 'Enter a positive amount.',
          collector_id: 'Collector is no longer eligible.',
        },
      },
      backgroundError: {
        kind: 'message',
        message: 'Could not refresh expense authority.',
      },
      refreshing: true,
      onRefresh,
      onRetryBackground,
    }).view;

    expect(screen.getByText('Enter an expense name.')).toBeTruthy();
    expect(screen.getByText('Enter a positive amount.')).toBeTruthy();
    expect(
      screen.getByText('Collector is no longer eligible.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Could not refresh expense authority.'),
    ).toBeTruthy();
    const refreshControl =
      screen.getByTestId('expense-form-scroll').props.refreshControl;
    expect(refreshControl.props.refreshing).toBe(true);
    refreshControl.props.onRefresh();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await fireEvent.press(
      screen.getByRole('button', {
        name: 'Retry refreshing expense form',
      }),
    );
    expect(onRetryBackground).toHaveBeenCalledTimes(1);
  });

  it('disables editing on authority loss and unchanged edit submit', async () => {
    const rendered = renderExpenseForm({
      mode: 'edit',
      canSubmit: false,
      dirty: false,
      authorityMessage: 'You can no longer edit this expense.',
    });
    await rendered.view;

    expect(screen.getByLabelText('Expense name').props.editable).toBe(
      false,
    );
    expect(
      screen.getByRole('button', { name: 'Save expense' }).props
        .accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      screen.getByText('You can no longer edit this expense.'),
    ).toBeTruthy();
  });
});
