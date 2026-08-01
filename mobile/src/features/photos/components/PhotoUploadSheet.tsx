import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
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

function remainingCount(snapshot: UploadSnapshot): number {
  return snapshot.items.filter(
    (item) =>
      item.state === 'queued' ||
      item.state === 'processing' ||
      item.state === 'ready' ||
      item.state === 'uploading',
  ).length;
}

export function uploadSummaryLine(snapshot: UploadSnapshot): string {
  switch (snapshot.phase) {
    case 'idle':
      return 'Ready to upload';
    case 'selected':
      return `${snapshot.selectedCount} selected`;
    case 'preprocessing': {
      const current =
        snapshot.items.find((item) => item.state === 'processing') ??
        snapshot.items.find((item) => item.state === 'queued');
      return `Preparing photo ${current?.index ?? snapshot.selectedCount} of ${snapshot.selectedCount}`;
    }
    case 'uploading': {
      const batchNumber = snapshot.activeBatch?.number ?? snapshot.batchesUploaded + 1;
      const itemCount =
        snapshot.activeBatch?.itemCount ??
        snapshot.items.filter((item) => item.state === 'uploading').length;
      return `Uploading batch ${batchNumber} · ${itemCount} photo${itemCount === 1 ? '' : 's'}`;
    }
    case 'paused':
      return 'Upload paused';
    case 'complete':
      return 'Upload complete';
    case 'partial':
      return 'Upload finished with issues';
    case 'throttled':
      return 'Upload limit reached';
    case 'stopped':
      return 'Upload stopped';
    case 'cancelled':
      return 'Upload cancelled';
    case 'tripGone':
      return 'Trip not found';
  }
}

function ActiveProgress({ snapshot }: { snapshot: UploadSnapshot }) {
  const batch = snapshot.activeBatch;
  if (snapshot.phase !== 'uploading' || !batch) return null;

  if (batch.totalBytes === null) {
    return (
      <View
        accessible
        accessibilityLabel={`Uploading batch ${batch.number}`}
        accessibilityRole="progressbar"
        style={styles.indeterminateProgress}
        testID="photo-upload-progress-indeterminate"
      >
        <ActivityIndicator color={colors.primary} size="small" />
        <Text style={styles.progressText}>Uploading…</Text>
      </View>
    );
  }

  const percent = Math.round(
    Math.min(100, Math.max(0, (batch.loadedBytes / batch.totalBytes) * 100)),
  );
  return (
    <View style={styles.progressSection} testID="photo-upload-progress-known">
      <View style={styles.progressHeading}>
        <Text style={styles.progressText}>Batch progress</Text>
        <Text style={styles.progressText}>{percent}%</Text>
      </View>
      <View
        accessible
        accessibilityLabel={`Upload progress ${percent} percent`}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
        style={styles.progressTrack}
      >
        <View
          style={[
            styles.progressFill,
            { width: `${percent}%`, minWidth: percent > 0 ? spacing.xs : 0 },
          ]}
        />
      </View>
    </View>
  );
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
    snapshot.phase === 'cancelled' ||
    snapshot.phase === 'tripGone';
  const remaining = remainingCount(snapshot);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={running ? undefined : onClose}
    >
      <View style={styles.sheet} testID="photo-upload-sheet">
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            Upload photos
          </Text>
          <Text accessibilityLiveRegion="polite" style={styles.summary}>
            {uploadSummaryLine(snapshot)}
          </Text>
          <Text style={styles.aggregate} testID="photo-upload-aggregate">
            {snapshot.uploadedCount} uploaded · {remaining} remaining
          </Text>
          <ActiveProgress snapshot={snapshot} />
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
  header: { gap: spacing.sm },
  title: { ...typography.heading, color: colors.text },
  summary: { ...typography.body, color: colors.text },
  aggregate: { ...typography.caption, color: colors.textMuted },
  body: { gap: spacing.md, paddingVertical: spacing.sm },
  note: { ...typography.caption, color: colors.textMuted },
  errorBox: { backgroundColor: colors.dangerSoft, borderRadius: radii.md, padding: spacing.md },
  errorText: { ...typography.body, color: colors.danger },
  rejectedBox: { backgroundColor: colors.surface, borderRadius: radii.md, gap: spacing.xs, padding: spacing.md },
  rejectedTitle: { ...typography.label, color: colors.text },
  rejectedItem: { ...typography.caption, color: colors.textMuted },
  progressSection: { gap: spacing.sm },
  progressHeading: { flexDirection: 'row', justifyContent: 'space-between' },
  progressText: { ...typography.caption, color: colors.textMuted },
  progressTrack: {
    backgroundColor: colors.surface,
    borderRadius: radii.full,
    height: spacing.sm,
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: colors.primary,
    borderRadius: radii.full,
    height: spacing.sm,
  },
  indeterminateProgress: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  footer: { gap: spacing.sm },
});
