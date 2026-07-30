import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import type { UploadSnapshot } from '../uploadSession';

interface PhotoUploadSheetProps {
  snapshot: UploadSnapshot;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}

const RUNNING_PHASES = new Set(['preprocessing', 'uploading']);

function summaryLine(snapshot: UploadSnapshot): string {
  switch (snapshot.phase) {
    case 'selected':
      return `${snapshot.selectedCount} selected`;
    case 'preprocessing':
      return `Preparing ${snapshot.processedCount} of ${snapshot.selectedCount}`;
    case 'uploading':
      // No total batch count: the boundaries depend on file count, bytes and
      // pixels together, so it is not known until everything is prepared.
      return `Uploading batch ${snapshot.batchesUploaded + 1}`;
    case 'paused':
      return 'Paused';
    case 'complete':
      return `${snapshot.uploadedCount} of ${snapshot.selectedCount} uploaded`;
    default:
      return `${snapshot.uploadedCount} of ${snapshot.selectedCount} uploaded`;
  }
}

export function PhotoUploadSheet({ snapshot, onStart, onStop, onClose }: PhotoUploadSheetProps) {
  const running = RUNNING_PHASES.has(snapshot.phase);
  const rejected = snapshot.items.filter((item) => item.state === 'rejected');
  const canStart = snapshot.phase === 'selected';
  const canResume = snapshot.phase === 'paused' || snapshot.phase === 'throttled';
  const finished =
    snapshot.phase === 'complete' ||
    snapshot.phase === 'partial' ||
    snapshot.phase === 'stopped' ||
    snapshot.phase === 'tripGone';

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      // Closing mid-mutation could orphan a batch whose outcome is still open.
      onRequestClose={running ? undefined : onClose}
    >
      <View style={styles.sheet} testID="photo-upload-sheet">
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            Upload photos
          </Text>
          <Text
            accessibilityLiveRegion="polite"
            // Announced at state and batch boundaries only — a byte-level
            // progress callback would talk over everything else.
            style={styles.summary}
          >
            {summaryLine(snapshot)}
          </Text>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {snapshot.error ? (
            <View style={styles.errorBox} testID="photo-upload-error">
              <Text style={styles.errorText}>{snapshot.error.message}</Text>
            </View>
          ) : null}

          {snapshot.unknownCount > 0 ? (
            <Text style={styles.note} testID="photo-upload-unknown">
              {snapshot.unknownCount} photo{snapshot.unknownCount === 1 ? '' : 's'} may or may not
              have been uploaded. The gallery has been refreshed to show what actually arrived.
            </Text>
          ) : null}

          {snapshot.pendingCount > 0 && finished ? (
            <Text style={styles.note}>
              {snapshot.pendingCount} photo{snapshot.pendingCount === 1 ? '' : 's'} were never sent.
            </Text>
          ) : null}

          {rejected.length > 0 ? (
            <View style={styles.rejectedBox} testID="photo-upload-rejected">
              <Text style={styles.rejectedTitle}>Skipped</Text>
              {rejected.map((item) => (
                <Text key={item.id} style={styles.rejectedItem}>
                  Photo {item.index}
                  {item.fileName ? ` (${item.fileName})` : ''}: {item.reason}
                </Text>
              ))}
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          {canStart ? <Button title="Start upload" onPress={onStart} /> : null}
          {canResume ? <Button title="Resume" onPress={onStart} /> : null}
          {running ? (
            <Button title="Stop after current batch" variant="secondary" onPress={onStop} />
          ) : null}
          {!running ? (
            <Button
              title={finished ? 'Done' : 'Close'}
              variant={canStart || canResume ? 'secondary' : 'primary'}
              onPress={onClose}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.background, flex: 1, gap: spacing.md, padding: spacing.lg },
  header: { gap: spacing.xs },
  title: { ...typography.heading, color: colors.text },
  summary: { ...typography.body, color: colors.textMuted },
  body: { gap: spacing.md, paddingVertical: spacing.sm },
  note: { ...typography.caption, color: colors.textMuted },
  errorBox: { backgroundColor: colors.dangerSoft, borderRadius: radii.md, padding: spacing.md },
  errorText: { ...typography.body, color: colors.danger },
  rejectedBox: { backgroundColor: colors.surface, borderRadius: radii.md, gap: spacing.xs, padding: spacing.md },
  rejectedTitle: { ...typography.label, color: colors.text },
  rejectedItem: { ...typography.caption, color: colors.textMuted },
  footer: { gap: spacing.sm },
});
