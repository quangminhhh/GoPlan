import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import type { AIActionDraft } from '../../drafts';
import {
  displayAmount,
  displayMetaRows,
  previewRows,
  type AIDisplayMetaRow,
} from '../../presentation';

export function AmountHero({ draft }: { readonly draft: AIActionDraft }) {
  const amount = displayAmount(draft);
  if (amount === null) {
    return null;
  }
  return (
    <View
      accessibilityLabel={`Amount ${amount.value} ${amount.currency}`}
      style={styles.amountRow}
      testID="ai-draft-amount"
    >
      <Text style={styles.amountValue}>{amount.value}</Text>
      <Text style={styles.amountCurrency}>{amount.currency}</Text>
    </View>
  );
}

export function DetailRows(props: {
  readonly rows: readonly AIDisplayMetaRow[];
  readonly testID?: string;
}) {
  if (props.rows.length === 0) {
    return null;
  }
  return (
    <View style={styles.rows} testID={props.testID}>
      {props.rows.map((row, index) => (
        <View key={`${row.label}-${index}`} style={styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          <Text selectable style={styles.value}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function DisplayMeta({ draft }: { readonly draft: AIActionDraft }) {
  return <DetailRows rows={displayMetaRows(draft.display)} />;
}

export function GenericPreview({ draft }: { readonly draft: AIActionDraft }) {
  return (
    <DetailRows rows={previewRows(draft.preview)} testID="ai-draft-preview" />
  );
}

const styles = StyleSheet.create({
  amountRow: {
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  amountValue: {
    ...typography.heading,
    flexShrink: 1,
    color: colors.text,
    fontWeight: '700',
  },
  amountCurrency: {
    ...typography.label,
    flexShrink: 0,
    color: colors.textMuted,
  },
  rows: { gap: spacing.sm },
  row: { minWidth: 0, gap: spacing.xs },
  label: { ...typography.caption, color: colors.textMuted },
  value: {
    ...typography.body,
    minWidth: 0,
    flexShrink: 1,
    color: colors.text,
  },
});
