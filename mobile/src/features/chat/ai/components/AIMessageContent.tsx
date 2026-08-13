import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import {
  parseConstrainedAIText,
  type AIInlineSegment,
} from '../constrainedText';

function InlineText(props: {
  readonly segments: readonly AIInlineSegment[];
  readonly style?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={props.style}>
      {props.segments.map((segment, index) => {
        const style =
          segment.kind === 'code'
            ? styles.inlineCode
            : segment.kind === 'strong'
              ? styles.strong
              : segment.kind === 'emphasis'
                ? styles.emphasis
                : null;
        return (
          <Text key={`${segment.kind}-${index}`} style={style}>
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function AIMessageContent({ content }: { readonly content: string }) {
  const blocks = parseConstrainedAIText(content);
  return (
    <View
      accessibilityLabel="GoPlanAI response"
      style={styles.container}
      testID="goplan-ai-message-content"
    >
      {blocks.map((block, index) => {
        if (block.kind === 'code_block') {
          const language = block.language || 'code';
          return (
            <View key={`code-${index}`} style={styles.codeBlock}>
              <Text style={styles.codeLabel}>{language}</Text>
              <ScrollView
                accessibilityLabel={`${language} code block`}
                contentContainerStyle={styles.codeScrollContent}
                horizontal
                showsHorizontalScrollIndicator
              >
                <Text selectable style={styles.codeText}>
                  {block.code}
                </Text>
              </ScrollView>
            </View>
          );
        }
        if (block.kind === 'heading') {
          return (
            <InlineText
              key={`heading-${index}`}
              segments={block.segments}
              style={styles.heading}
            />
          );
        }
        if (block.kind === 'list_item') {
          return (
            <View key={`list-${index}`} style={styles.listRow}>
              <Text style={styles.listMarker}>
                {block.ordered ? `${block.ordinal ?? 1}.` : '•'}
              </Text>
              <View style={styles.listContent}>
                <InlineText
                  segments={block.segments}
                  style={styles.body}
                />
              </View>
            </View>
          );
        }
        return (
          <InlineText
            key={`paragraph-${index}`}
            segments={block.segments}
            style={styles.body}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  body: { ...typography.body, color: colors.text },
  heading: {
    ...typography.body,
    color: colors.text,
    fontWeight: '700',
  },
  strong: { fontWeight: '700' },
  emphasis: { fontStyle: 'italic' },
  inlineCode: {
    color: colors.slate,
    backgroundColor: colors.slateSoft,
  },
  listRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  listMarker: {
    ...typography.body,
    minWidth: spacing.md,
    color: colors.textMuted,
    textAlign: 'right',
  },
  listContent: { minWidth: 0, flex: 1 },
  codeBlock: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  codeLabel: {
    ...typography.label,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textMuted,
    textTransform: 'uppercase',
    backgroundColor: colors.slateSoft,
  },
  codeScrollContent: {
    minWidth: '100%',
    padding: spacing.md,
  },
  codeText: {
    ...typography.caption,
    color: colors.text,
  },
});
