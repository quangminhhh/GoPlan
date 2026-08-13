import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  isKnownAIActionType,
  aiActionDraftSourceIdentity,
  type AIActionDraft,
  type AIActionDraftStatus,
} from '../drafts';
import {
  confirmationAuthorityText,
  confirmationRestatement,
  draftKicker,
  draftTitle,
  previewRows,
} from '../presentation';
import { useAIActionDraftExpiry } from '../useExpiryClock';
import { useAIConfirmRetryClock } from '../useConfirmRetryClock';
import { focusAccessibilityNode } from '../accessibilityFocus';
import { DraftFieldEditor } from './DraftFieldEditor';
import { ExpenseDraftDetails } from './renderers/ExpenseDraftDetails';
import { GenericDraftDetails } from './renderers/GenericDraftDetails';
import { SettlementDraftDetails } from './renderers/SettlementDraftDetails';
import { DetailRows } from './renderers/shared';
import { TimelineDraftDetails } from './renderers/TimelineDraftDetails';
import { TransferDraftDetails } from './renderers/TransferDraftDetails';

export type AIActionDraftPendingOperation =
  | 'patch'
  | 'confirm'
  | 'cancel'
  | 'check'
  | null;

export interface AIActionDraftSubmittedEdit {
  readonly fields: AIActionDraft['missing_fields'];
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ActionDraftCardProps {
  readonly draft: AIActionDraft;
  readonly interactionDisabled?: boolean;
  readonly pending?: AIActionDraftPendingOperation;
  readonly feedback?: string | null;
  readonly fieldErrors?: Readonly<Record<string, string>> | null;
  readonly confirmOutcomeUnknown?: boolean;
  readonly confirmRetryAtMs?: number | null;
  readonly retainedExpiredEdit?: AIActionDraftSubmittedEdit | null;
  readonly editableDraftEdit?: AIActionDraftSubmittedEdit | null;
  readonly nowMs?: number;
  readonly onPatch: (
    draft: AIActionDraft,
    payload: Readonly<Record<string, unknown>>,
    submittedEdit: AIActionDraftSubmittedEdit,
  ) => void | Promise<void>;
  readonly onConfirm: (draft: AIActionDraft) => void | Promise<void>;
  readonly onCancel: (draft: AIActionDraft) => void | Promise<void>;
  readonly onCheckStatus: (draft: AIActionDraft) => void | Promise<void>;
  readonly onEditableDraftEditChange?: (
    edit: AIActionDraftSubmittedEdit | null,
  ) => void;
}

type ReviewPanel = 'confirm' | 'cancel' | 'edit' | null;

interface ReviewPanelState {
  readonly panel: Exclude<ReviewPanel, null>;
  readonly draftVersion: string;
}

const STATUS_LABELS: Readonly<Record<AIActionDraftStatus, string>> = {
  NEEDS_INFO: 'Needs info',
  READY: 'Ready',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  FAILED: 'Failed',
};

const STATUS_TONES: Readonly<
  Record<
    AIActionDraftStatus,
    {
      readonly pill: { readonly backgroundColor: string };
      readonly text: { readonly color: string };
    }
  >
> = {
  NEEDS_INFO: {
    pill: { backgroundColor: colors.warningSoft },
    text: { color: colors.warning },
  },
  READY: {
    pill: { backgroundColor: colors.successSoft },
    text: { color: colors.success },
  },
  CONFIRMED: {
    pill: { backgroundColor: colors.primarySoft },
    text: { color: colors.primary },
  },
  CANCELLED: {
    pill: { backgroundColor: colors.roseSoft },
    text: { color: colors.rose },
  },
  EXPIRED: {
    pill: { backgroundColor: colors.amberSoft },
    text: { color: colors.amber },
  },
  FAILED: {
    pill: { backgroundColor: colors.dangerSoft },
    text: { color: colors.danger },
  },
};

function ActionGlyph({ draft }: { readonly draft: AIActionDraft }) {
  const glyph = draft.action_type.startsWith('timeline.')
    ? 'T'
    : draft.action_type.startsWith('expense.')
      ? '$'
      : draft.action_type.startsWith('settlement.transfer.')
        ? '↔'
        : draft.action_type.startsWith('settlement.')
          ? 'S'
          : 'AI';
  return (
    <View
      accessibilityLabel={`${draftKicker(draft)} action`}
      style={styles.icon}
    >
      <Text style={styles.iconText}>{glyph}</Text>
    </View>
  );
}

const StatusPill = forwardRef<
  ComponentRef<typeof View>,
  { readonly status: AIActionDraftStatus }
>(function StatusPill({ status }, ref) {
  const tone = STATUS_TONES[status];
  return (
    <View
      accessibilityLabel={`Draft status: ${STATUS_LABELS[status]}`}
      accessibilityRole="text"
      ref={ref}
      style={[styles.statusPill, tone.pill]}
    >
      <Text style={[styles.statusText, tone.text]}>
        {STATUS_LABELS[status]}
      </Text>
    </View>
  );
});

function StatusDetails(props: {
  readonly draft: AIActionDraft;
  readonly visualStatus: AIActionDraftStatus;
}) {
  const { draft, visualStatus } = props;
  if (visualStatus === 'NEEDS_INFO') {
    return (
      <View style={styles.stateDetails}>
        <Text style={styles.stateText}>Information is still required:</Text>
        {draft.missing_fields.map((field) => (
          <Text key={field.name} style={styles.missingField}>
            • {field.label}
          </Text>
        ))}
      </View>
    );
  }
  if (visualStatus === 'READY') {
    return (
      <Text style={styles.stateText}>
        Review every value before explicitly confirming this shared trip change.
      </Text>
    );
  }
  if (visualStatus === 'CONFIRMED') {
    return (
      <View style={styles.stateDetails}>
        <Text style={styles.confirmedText}>The action was confirmed.</Text>
        <DetailRows rows={previewRows(draft.result)} testID="ai-draft-result" />
      </View>
    );
  }
  if (visualStatus === 'CANCELLED') {
    return <Text style={styles.stateText}>This draft was cancelled.</Text>;
  }
  if (visualStatus === 'EXPIRED') {
    return (
      <Text style={styles.stateText}>
        This draft expired and can no longer be changed or confirmed.
      </Text>
    );
  }
  return (
    <View style={styles.stateDetails}>
      <Text style={styles.failedText}>The proposed action failed.</Text>
      {draft.error_code.trim().length > 0 ? (
        <Text style={styles.stateText}>Code: {draft.error_code}</Text>
      ) : null}
      {draft.error_detail.trim().length > 0 ? (
        <Text style={styles.stateText}>{draft.error_detail}</Text>
      ) : null}
    </View>
  );
}

function DraftSpecificDetails({ draft }: { readonly draft: AIActionDraft }) {
  if (!isKnownAIActionType(draft.action_type)) {
    return <GenericDraftDetails draft={draft} />;
  }
  if (draft.action_type.startsWith('timeline.activity.')) {
    return <TimelineDraftDetails draft={draft} />;
  }
  if (draft.action_type.startsWith('expense.')) {
    return <ExpenseDraftDetails draft={draft} />;
  }
  if (draft.action_type.startsWith('settlement.transfer.')) {
    return <TransferDraftDetails draft={draft} />;
  }
  return <SettlementDraftDetails draft={draft} />;
}

interface ActionButtonProps {
  readonly label: string;
  readonly tone?: 'primary' | 'neutral' | 'danger';
  readonly disabled: boolean;
  readonly busy?: boolean;
  readonly onPress: () => void;
}

const ActionButton = forwardRef<
  ComponentRef<typeof Pressable>,
  ActionButtonProps
>(function ActionButton(props, ref) {
  const tone = props.tone ?? 'neutral';
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, busy: props.busy ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      ref={ref}
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'primary'
          ? styles.primaryButton
          : tone === 'danger'
            ? styles.dangerButton
            : styles.neutralButton,
        pressed && !props.disabled ? styles.buttonPressed : null,
        props.disabled ? styles.disabled : null,
      ]}
    >
      <Text
        style={[
          styles.actionButtonText,
          tone === 'primary'
            ? styles.primaryButtonText
            : tone === 'danger'
              ? styles.dangerButtonText
              : styles.neutralButtonText,
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
});

function ReviewModalShell(props: {
  readonly dismissible: boolean;
  readonly children: ReactNode;
  readonly kind: 'confirm' | 'cancel';
  readonly visible: boolean;
  readonly onDismiss: () => void;
  readonly onRequestClose: () => void;
  readonly onShow: () => void;
}) {
  if (!props.visible) {
    return null;
  }
  return (
    <Modal
      allowSwipeDismissal={props.dismissible}
      animationType="slide"
      onDismiss={props.onDismiss}
      onRequestClose={props.onRequestClose}
      onShow={props.onShow}
      presentationStyle="formSheet"
      testID={`ai-draft-${props.kind}-modal`}
      visible
    >
      <SafeAreaView style={styles.modalSafeArea}>
        <ScrollView
          contentContainerStyle={styles.modalScrollContent}
          contentInsetAdjustmentBehavior="automatic"
        >
          <View
            accessibilityLabel={`${props.kind === 'confirm' ? 'Confirm' : 'Cancel'} AI action draft review`}
            accessibilityViewIsModal
            style={styles.reviewPanel}
            testID={`ai-draft-${props.kind}-modal-content`}
          >
            {props.children}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export function ActionDraftCard({
  draft,
  interactionDisabled = false,
  pending = null,
  feedback = null,
  fieldErrors = null,
  confirmOutcomeUnknown = false,
  confirmRetryAtMs = null,
  retainedExpiredEdit = null,
  editableDraftEdit = null,
  nowMs,
  onPatch,
  onConfirm,
  onCancel,
  onCheckStatus,
  onEditableDraftEditChange,
}: ActionDraftCardProps) {
  const [reviewState, setReviewState] = useState<ReviewPanelState | null>(null);
  const actionLockRef = useRef<symbol | null>(null);
  const interactionDisabledRef = useRef(interactionDisabled);
  const confirmTriggerRef = useRef<ComponentRef<typeof Pressable>>(null);
  const cancelTriggerRef = useRef<ComponentRef<typeof Pressable>>(null);
  const confirmHeadingRef = useRef<ComponentRef<typeof Text>>(null);
  const cancelHeadingRef = useRef<ComponentRef<typeof Text>>(null);
  const statusPillRef = useRef<ComponentRef<typeof View>>(null);
  const returnFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnFocusPanelRef = useRef<'confirm' | 'cancel' | null>(null);
  const expiry = useAIActionDraftExpiry(draft, nowMs);
  const confirmRetry = useAIConfirmRetryClock(confirmRetryAtMs, nowMs);
  const busy = pending !== null;
  const locallyDisabled = busy || expiry.isExpired || interactionDisabled;
  const draftVersion = aiActionDraftSourceIdentity(draft);
  const submittedFocusIntentRef = useRef<{
    readonly panel: 'confirm' | 'cancel';
    readonly draftVersion: string;
  } | null>(null);
  const reviewPanel: ReviewPanel =
    reviewState?.draftVersion === draftVersion
      ? reviewState.panel
      : editableDraftEdit !== null && draft.can_edit
        ? 'edit'
        : null;

  useLayoutEffect(() => {
    interactionDisabledRef.current = interactionDisabled;
  }, [interactionDisabled]);

  const showPanel = (panel: Exclude<ReviewPanel, null>): void => {
    if (interactionDisabledRef.current) {
      return;
    }
    submittedFocusIntentRef.current = null;
    if (panel === 'edit' && editableDraftEdit === null) {
      onEditableDraftEditChange?.({
        fields: draft.missing_fields,
        values: {},
      });
    }
    setReviewState({ panel, draftVersion });
  };
  const completeTriggerFocus = useCallback((): void => {
    if (returnFocusTimerRef.current !== null) {
      clearTimeout(returnFocusTimerRef.current);
      returnFocusTimerRef.current = null;
    }
    const panel = returnFocusPanelRef.current;
    returnFocusPanelRef.current = null;
    if (panel === null) {
      return;
    }
    const trigger =
      panel === 'confirm'
        ? confirmTriggerRef.current
        : cancelTriggerRef.current;
    focusAccessibilityNode(trigger ?? statusPillRef.current);
    const submittedIntent = submittedFocusIntentRef.current;
    if (
      trigger === null &&
      submittedIntent?.panel === panel
    ) {
      submittedFocusIntentRef.current = null;
    }
  }, []);
  const scheduleTriggerFocus = (panel: 'confirm' | 'cancel'): void => {
    returnFocusPanelRef.current = panel;
    if (returnFocusTimerRef.current !== null) {
      clearTimeout(returnFocusTimerRef.current);
    }
    returnFocusTimerRef.current = setTimeout(() => {
      completeTriggerFocus();
    }, 500);
  };
  const closePanel = (
    panel: 'confirm' | 'cancel',
    submitted = false,
  ): void => {
    if (submitted) {
      submittedFocusIntentRef.current = { panel, draftVersion };
    }
    setReviewState(null);
    scheduleTriggerFocus(panel);
  };
  const closeReview = (): void => {
    if (!busy && (reviewPanel === 'confirm' || reviewPanel === 'cancel')) {
      closePanel(reviewPanel);
    }
  };

  const priorDraftVersionRef = useRef(draftVersion);
  useLayoutEffect(() => {
    if (priorDraftVersionRef.current === draftVersion) {
      return;
    }
    const priorDraftVersion = priorDraftVersionRef.current;
    priorDraftVersionRef.current = draftVersion;
    actionLockRef.current = null;
    const submittedIntent = submittedFocusIntentRef.current;
    if (submittedIntent?.draftVersion === priorDraftVersion) {
      if (returnFocusPanelRef.current !== submittedIntent.panel) {
        const trigger =
          submittedIntent.panel === 'confirm'
            ? confirmTriggerRef.current
            : cancelTriggerRef.current;
        if (trigger === null) {
          focusAccessibilityNode(statusPillRef.current);
        }
      }
      submittedFocusIntentRef.current = null;
    }
    const stalePanel = reviewState?.panel ?? null;
    setReviewState(null);
    if (stalePanel === 'confirm' || stalePanel === 'cancel') {
      returnFocusPanelRef.current = stalePanel;
      if (returnFocusTimerRef.current !== null) {
        clearTimeout(returnFocusTimerRef.current);
      }
      returnFocusTimerRef.current = setTimeout(() => {
        completeTriggerFocus();
      }, 500);
    }
  }, [draftVersion, reviewState, completeTriggerFocus]);

  const priorPendingRef = useRef(pending);
  useLayoutEffect(() => {
    const priorPending = priorPendingRef.current;
    priorPendingRef.current = pending;
    if (
      priorPending !== null &&
      pending === null &&
      submittedFocusIntentRef.current?.draftVersion === draftVersion
    ) {
      submittedFocusIntentRef.current = null;
    }
  }, [draftVersion, pending]);

  useEffect(
    () => () => {
      if (returnFocusTimerRef.current !== null) {
        clearTimeout(returnFocusTimerRef.current);
        returnFocusTimerRef.current = null;
      }
      returnFocusPanelRef.current = null;
      submittedFocusIntentRef.current = null;
    },
    [],
  );

  const save = async (
    payload: Readonly<Record<string, unknown>>,
    editedValues: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (
      actionLockRef.current !== null ||
      busy ||
      interactionDisabledRef.current ||
      expiry.isExpired ||
      !draft.can_edit
    ) {
      return;
    }
    const lockOwner = Symbol('ai-draft-patch');
    actionLockRef.current = lockOwner;
    try {
      await onPatch(draft, payload, {
        fields: draft.missing_fields,
        values: editedValues,
      });
    } finally {
      if (actionLockRef.current === lockOwner) {
        actionLockRef.current = null;
      }
    }
  };

  const runAction = async (
    action: (current: AIActionDraft) => void | Promise<void>,
    permitted: boolean,
  ): Promise<void> => {
    if (
      actionLockRef.current !== null ||
      busy ||
      interactionDisabledRef.current ||
      !permitted
    ) {
      return;
    }
    const lockOwner = Symbol('ai-draft-action');
    actionLockRef.current = lockOwner;
    try {
      await action(draft);
    } finally {
      if (actionLockRef.current === lockOwner) {
        actionLockRef.current = null;
      }
    }
  };
  const visibleEdit = retainedExpiredEdit ?? editableDraftEdit;
  const editorDraft =
    visibleEdit === null
      ? draft
      : { ...draft, missing_fields: visibleEdit.fields };

  return (
    <View
      accessibilityLabel={`${draftKicker(draft)} draft, ${STATUS_LABELS[expiry.visualStatus]}`}
      style={styles.card}
      testID={`ai-action-draft-${draft.id}`}
    >
      <View style={styles.header}>
        <ActionGlyph draft={draft} />
        <View style={styles.headingBlock}>
          <Text style={styles.kicker}>{draftKicker(draft)}</Text>
          <Text style={styles.title}>{draftTitle(draft)}</Text>
        </View>
        <StatusPill ref={statusPillRef} status={expiry.visualStatus} />
      </View>

      <Text
        accessibilityLabel={`Draft expiry: ${expiry.label}`}
        style={styles.expiry}
        testID="ai-draft-expiry"
      >
        {expiry.label}
      </Text>

      <DraftSpecificDetails draft={draft} />
      <StatusDetails draft={draft} visualStatus={expiry.visualStatus} />

      {feedback !== null ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.feedback}
        >
          {feedback}
        </Text>
      ) : null}

      {visibleEdit !== null ||
      (reviewPanel === 'edit' && draft.can_edit) ? (
        <DraftFieldEditor
          disabled={locallyDisabled || retainedExpiredEdit !== null}
          disabledMessage={
            retainedExpiredEdit !== null || expiry.isExpired
              ? 'This draft expired. Your edits were not applied.'
              : null
          }
          draft={editorDraft}
          fieldErrors={fieldErrors}
          initialValues={visibleEdit?.values}
          onValuesChange={(values) =>
            onEditableDraftEditChange?.({
              fields: editorDraft.missing_fields,
              values,
            })
          }
          onSave={save}
          pending={pending === 'patch'}
        />
      ) : null}

      <ReviewModalShell
        dismissible={!busy}
        kind="confirm"
        onDismiss={completeTriggerFocus}
        onRequestClose={closeReview}
        onShow={() => focusAccessibilityNode(confirmHeadingRef.current)}
        visible={
          reviewPanel === 'confirm' &&
          draft.can_confirm &&
          !confirmOutcomeUnknown
        }
      >
          <Text
            accessibilityRole="header"
            ref={confirmHeadingRef}
            style={styles.reviewTitle}
          >
            Confirm this action?
          </Text>
          <Text style={styles.reviewText}>{confirmationRestatement(draft)}</Text>
          <Text style={styles.authorityText}>{confirmationAuthorityText(draft)}</Text>
          {expiry.isExpired ? (
            <Text accessibilityRole="alert" style={styles.feedback}>
              This draft expired and cannot be confirmed.
            </Text>
          ) : null}
          {confirmRetry.label !== null ? (
            <Text accessibilityRole="alert" style={styles.retryText}>
              {confirmRetry.label}. Close this review and wait before confirming.
            </Text>
          ) : null}
          <View style={styles.reviewActions}>
            <ActionButton
              disabled={busy}
              label="Back to review"
              onPress={closeReview}
            />
            <ActionButton
              busy={pending === 'confirm'}
              disabled={locallyDisabled || confirmRetry.blocked}
              label="Confirm this action"
              onPress={() => {
                closePanel('confirm', true);
                void runAction(
                  onConfirm,
                  draft.can_confirm &&
                    !expiry.isExpired &&
                    !confirmRetry.blocked,
                );
              }}
              tone="primary"
            />
          </View>
      </ReviewModalShell>

      <ReviewModalShell
        dismissible={!busy}
        kind="cancel"
        onDismiss={completeTriggerFocus}
        onRequestClose={closeReview}
        onShow={() => focusAccessibilityNode(cancelHeadingRef.current)}
        visible={reviewPanel === 'cancel' && draft.can_cancel}
      >
          <Text
            accessibilityRole="header"
            ref={cancelHeadingRef}
            style={styles.reviewTitle}
          >
            Cancel this draft?
          </Text>
          <Text style={styles.reviewText}>
            The proposal will be discarded and will not change trip data.
          </Text>
          {expiry.isExpired ? (
            <Text accessibilityRole="alert" style={styles.feedback}>
              This draft expired and cannot be cancelled.
            </Text>
          ) : null}
          <View style={styles.reviewActions}>
            <ActionButton
              disabled={busy}
              label="Keep reviewing"
              onPress={closeReview}
            />
            <ActionButton
              busy={pending === 'cancel'}
              disabled={locallyDisabled}
              label="Cancel this draft"
              onPress={() => {
                closePanel('cancel', true);
                void runAction(
                  onCancel,
                  draft.can_cancel && !expiry.isExpired,
                );
              }}
              tone="danger"
            />
          </View>
      </ReviewModalShell>

      {confirmOutcomeUnknown ? (
        <View style={styles.unknownOutcome}>
          <Text style={styles.unknownOutcomeText}>
            Confirmation outcome is unknown. Do not confirm again.
          </Text>
          <ActionButton
            busy={pending === 'check'}
            disabled={busy || interactionDisabled}
            label="Check status"
            onPress={() => void runAction(onCheckStatus, true)}
          />
        </View>
      ) : (
        <View style={styles.actionSection}>
          {draft.can_confirm && confirmRetry.label !== null ? (
            <Text
              accessibilityLiveRegion="polite"
              style={styles.retryText}
              testID="ai-confirm-retry-deadline"
            >
              {confirmRetry.label}
            </Text>
          ) : null}
          <View style={styles.actions} testID="ai-draft-actions">
          {draft.can_edit ? (
            <ActionButton
              disabled={locallyDisabled}
              label="Edit draft"
              onPress={() => showPanel('edit')}
            />
          ) : null}
          {draft.can_cancel ? (
            <ActionButton
              disabled={locallyDisabled}
              label="Cancel"
              onPress={() => showPanel('cancel')}
              ref={cancelTriggerRef}
              tone="danger"
            />
          ) : null}
          {draft.can_confirm ? (
            <ActionButton
              disabled={locallyDisabled || confirmRetry.blocked}
              label="Confirm"
              onPress={() => showPanel('confirm')}
              ref={confirmTriggerRef}
              tone="primary"
            />
          ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minWidth: 0,
    width: '100%',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.background,
  },
  header: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  icon: {
    width: spacing.xl,
    minHeight: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.primarySoft,
  },
  iconText: { ...typography.label, color: colors.primary },
  headingBlock: { minWidth: 0, flex: 1, gap: spacing.xxs },
  kicker: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  title: {
    ...typography.body,
    minWidth: 0,
    flexShrink: 1,
    color: colors.text,
    fontWeight: '700',
  },
  statusPill: {
    minHeight: spacing.xl,
    flexShrink: 0,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderCurve: 'continuous',
  },
  statusText: { ...typography.label },
  expiry: { ...typography.caption, color: colors.textMuted },
  stateDetails: { gap: spacing.xs },
  stateText: { ...typography.caption, color: colors.textMuted },
  missingField: { ...typography.caption, color: colors.warning },
  confirmedText: { ...typography.caption, color: colors.success },
  failedText: { ...typography.caption, color: colors.danger, fontWeight: '600' },
  feedback: { ...typography.caption, color: colors.danger },
  actionSection: { gap: spacing.sm },
  retryText: { ...typography.caption, color: colors.warning },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    borderCurve: 'continuous',
  },
  primaryButton: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  neutralButton: {
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  dangerButton: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSoft,
  },
  actionButtonText: { ...typography.label, textAlign: 'center' },
  primaryButtonText: { color: colors.background },
  neutralButtonText: { color: colors.text },
  dangerButtonText: { color: colors.danger },
  buttonPressed: { opacity: 0.62 },
  disabled: { opacity: 0.45 },
  reviewPanel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.warningSoft,
  },
  modalSafeArea: { flex: 1, backgroundColor: colors.background },
  modalScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.md,
  },
  reviewTitle: { ...typography.body, color: colors.text, fontWeight: '700' },
  reviewText: { ...typography.body, color: colors.text },
  authorityText: { ...typography.caption, color: colors.textMuted },
  reviewActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  unknownOutcome: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.md,
    borderCurve: 'continuous',
    backgroundColor: colors.warningSoft,
  },
  unknownOutcomeText: { ...typography.body, color: colors.text },
});
