const mockIonicons = jest.fn((_props: unknown) => null);

jest.mock('@expo/vector-icons', () => ({
  Ionicons: (props: unknown) => mockIonicons(props),
}));

// eslint-disable-next-line import/first
import { Alert } from 'react-native';
// eslint-disable-next-line import/first
import {
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { SettlementPanel } from '../components/SettlementPanel';
// eslint-disable-next-line import/first
import { TransferRow } from '../components/TransferRow';
// eslint-disable-next-line import/first
import type {
  SettlementTransfer,
  TripSettlement,
} from '../types';

function buildTransfer(
  overrides: Partial<SettlementTransfer> = {},
): SettlementTransfer {
  return {
    id: 'transfer-1',
    payer: {
      id: 'payer-1',
      display_name: 'Payer User',
      identify_tag: 'payer#1000',
    },
    recipient: {
      id: 'recipient-1',
      display_name: 'Recipient User',
      identify_tag: 'recipient#2000',
    },
    amount: '40.00',
    payer_marked_sent_at: null,
    recipient_confirmed_at: null,
    ...overrides,
  };
}

function buildSettlement(
  overrides: Partial<TripSettlement> = {},
): TripSettlement {
  return {
    id: 'settlement-1',
    status: 'FINALIZED',
    finalized_at: '2026-07-28T03:00:00Z',
    transfers: [],
    ...overrides,
  };
}

function confirmLastAlert(): void {
  const [, , buttons] = jest.mocked(Alert.alert).mock.calls.at(-1) ?? [];
  const confirm = buttons?.find((button) => button.text !== 'Cancel');
  confirm?.onPress?.();
}

describe('SettlementPanel', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the finalized notice and Reopen for a valid solo settlement', async () => {
    const onReopen = jest.fn();
    jest.spyOn(Alert, 'alert');
    await render(
      <SettlementPanel
        settlement={buildSettlement()}
        canReopen
        onReopen={onReopen}
      />,
    );

    expect(
      screen.getByText(
        'Settlement finalized. Expenses are locked.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'No transfers are needed for this settlement.',
      ),
    ).toBeTruthy();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Reopen settlement' }),
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      'Reopen settlement?',
      'Expenses and contributions will be unlocked for editing.',
      expect.any(Array),
    );
    confirmLastAlert();
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it('does not render a reopened settlement or unauthorized Reopen action', async () => {
    const rendered = await render(
      <SettlementPanel
        settlement={buildSettlement()}
        canReopen={false}
        onReopen={jest.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Reopen settlement' }),
    ).toBeNull();

    await rendered.rerender(
      <SettlementPanel
        settlement={buildSettlement({ status: 'REOPENED' })}
        canReopen
        onReopen={jest.fn()}
      />,
    );
    expect(screen.queryByText('Settlement finalized')).toBeNull();
  });

  it('renders a normalized per-action error passed by the owner', async () => {
    await render(
      <SettlementPanel
        settlement={buildSettlement()}
        canReopen
        error={{
          kind: 'message',
          message: 'Settlement is no longer finalized.',
          status: 409,
        }}
        onReopen={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('alert', {
        name: 'Settlement is no longer finalized.',
      }),
    ).toBeTruthy();
  });
});

describe('TransferRow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets only the payer confirm an unsent transfer with exact wording', async () => {
    const onMarkSent = jest.fn();
    jest.spyOn(Alert, 'alert');
    await render(
      <TransferRow
        transfer={buildTransfer()}
        currencyCode="USD"
        viewerId="payer-1"
        onMarkSent={onMarkSent}
        onConfirmReceived={jest.fn()}
      />,
    );

    expect(screen.getByText('Not sent')).toBeTruthy();
    expect(screen.getByText('Not received')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'I received it' }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole('button', { name: 'I sent it' }),
    );

    expect(Alert.alert).toHaveBeenCalledWith(
      'Confirm transfer sent?',
      'You are confirming that you sent money to Recipient User.',
      expect.any(Array),
    );
    confirmLastAlert();
    expect(onMarkSent).toHaveBeenCalledWith('transfer-1');
  });

  it('lets the recipient confirm only after sent and renders guidance', async () => {
    const onConfirmReceived = jest.fn();
    jest.spyOn(Alert, 'alert');
    await render(
      <TransferRow
        transfer={buildTransfer({
          payer_marked_sent_at: '2026-07-28T03:10:00Z',
        })}
        currencyCode="USD"
        viewerId="recipient-1"
        onMarkSent={jest.fn()}
        onConfirmReceived={onConfirmReceived}
      />,
    );

    expect(
      screen.getByText(
        'Payer User marked this as sent. Confirm only after the money arrives.',
      ),
    ).toBeTruthy();
    await fireEvent.press(
      screen.getByRole('button', { name: 'I received it' }),
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      'Confirm transfer received?',
      'You are confirming that you received money from Payer User.',
      expect.any(Array),
    );
    confirmLastAlert();
    expect(onConfirmReceived).toHaveBeenCalledWith('transfer-1');
  });

  it.each([
    ['recipient before sent', 'recipient-1'],
    ['unrelated viewer', 'viewer-9'],
    ['nullable unresolved viewer', null],
  ])(
    'renders tracking-only UI for %s',
    async (_label, viewerId) => {
      await render(
        <TransferRow
          transfer={buildTransfer()}
          currencyCode="USD"
          viewerId={viewerId}
          onMarkSent={jest.fn()}
          onConfirmReceived={jest.fn()}
        />,
      );

      expect(screen.getByText('Tracking')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'I sent it' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'I received it' }),
      ).toBeNull();
    },
  );

  it('renders sent/received completion without any action', async () => {
    await render(
      <TransferRow
        transfer={buildTransfer({
          payer_marked_sent_at: '2026-07-28T03:10:00Z',
          recipient_confirmed_at: '2026-07-28T03:15:00Z',
        })}
        currencyCode="USD"
        viewerId="payer-1"
        onMarkSent={jest.fn()}
        onConfirmReceived={jest.fn()}
      />,
    );

    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('Received')).toBeTruthy();
    expect(screen.getByText('Tracking')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses owner-provided per-row loading and error without a terminal gate', async () => {
    await render(
      <TransferRow
        transfer={buildTransfer()}
        currencyCode="USD"
        viewerId="payer-1"
        loading
        error={{
          kind: 'message',
          message: 'Transfer changed in another session.',
          status: 409,
        }}
        onMarkSent={jest.fn()}
        onConfirmReceived={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'I sent it' }).props
        .accessibilityState,
    ).toMatchObject({ busy: true, disabled: true });
    expect(
      screen.getByText('Transfer changed in another session.'),
    ).toBeTruthy();
  });
});
