import {
  ActivityIndicator,
  Linking,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { PHOTO_SAVE_SELECTION_MAX } from '../constants';
import type { SelectionSaveFeedback } from '../hooks/usePhotoSelection';
import type { SelectedSaveSnapshot } from '../selectedPhotoSaveSession';

interface PhotoSelectionBarProps {
  selectedCount: number;
  loadedCount: number;
  saveSnapshot: SelectedSaveSnapshot | null;
  feedback: SelectionSaveFeedback | null;
  onSelectLoaded: () => void;
  onClear: () => void;
  onExit: () => void;
  onSave: () => void;
  onCancelSave: () => void;
  onHeightChange?: (height: number) => void;
  onOpenSettings?: () => void;
}

function progressLabel(snapshot: SelectedSaveSnapshot | null): string | null {
  if (!snapshot) return null;
  const ordinal =
    snapshot.currentOrdinal === null
      ? null
      : Math.min(snapshot.total, Math.max(1, snapshot.currentOrdinal));
  if (snapshot.phase === 'requestingPermission') return 'Requesting Photos access…';
  if (snapshot.phase === 'stopping') {
    return ordinal === null
      ? 'Stopping after the current photo…'
      : `Stopping after photo ${ordinal} of ${snapshot.total}…`;
  }
  if (snapshot.phase === 'paused') return 'Saving paused.';
  if (snapshot.phase !== 'running' || ordinal === null) return null;

  if (snapshot.stage === 'saving') {
    return `Saving ${ordinal} of ${snapshot.total}`;
  }
  if (snapshot.stage === 'downloading') {
    return `Downloading ${ordinal} of ${snapshot.total}`;
  }
  return `Preparing ${ordinal} of ${snapshot.total}`;
}

function countsLabel(snapshot: SelectedSaveSnapshot | null): string | null {
  if (!snapshot) return null;
  const { counts } = snapshot;
  return [
    `${counts.committed} saved`,
    counts.terminalSkipped > 0 ? `${counts.terminalSkipped} unavailable` : null,
    counts.retryableFailed > 0 ? `${counts.retryableFailed} failed` : null,
    counts.unknown > 0 ? `${counts.unknown} unknown` : null,
    `${counts.unattempted} not saved`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

export function PhotoSelectionBar({
  selectedCount,
  loadedCount,
  saveSnapshot,
  feedback,
  onSelectLoaded,
  onClear,
  onExit,
  onSave,
  onCancelSave,
  onHeightChange,
  onOpenSettings = () => {
    void Linking.openSettings();
  },
}: PhotoSelectionBarProps) {
  const active =
    saveSnapshot?.phase === 'requestingPermission' ||
    saveSnapshot?.phase === 'running' ||
    saveSnapshot?.phase === 'stopping';
  const stopping = saveSnapshot?.phase === 'stopping';
  const atCap = selectedCount >= PHOTO_SAVE_SELECTION_MAX;
  const hasSession = saveSnapshot !== null;
  const progress = progressLabel(saveSnapshot);
  const progressValue =
    active && saveSnapshot?.currentOrdinal !== null && saveSnapshot?.currentOrdinal !== undefined
      ? {
          min: 1,
          max: saveSnapshot.total,
          now: Math.min(saveSnapshot.total, Math.max(1, saveSnapshot.currentOrdinal)),
        }
      : undefined;
  const counts = countsLabel(saveSnapshot);
  const selectLabel =
    loadedCount >= PHOTO_SAVE_SELECTION_MAX ? 'Select up to 100' : 'Select all loaded';
  const primaryLabel =
    saveSnapshot?.phase === 'paused'
      ? 'Resume'
      : saveSnapshot?.phase === 'completed'
        ? saveSnapshot.counts.unknown > 0
          ? 'Save remaining'
          : 'Retry'
        : 'Save to Photos';
  const showSettings =
    saveSnapshot?.permissionDenied !== null &&
    saveSnapshot?.permissionDenied !== undefined &&
    !saveSnapshot.permissionDenied.canAskAgain;

  return (
    <View
      style={styles.bar}
      onLayout={(event: LayoutChangeEvent) => onHeightChange?.(event.nativeEvent.layout.height)}
      testID="photo-selection-bar"
    >
      {feedback ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={[styles.notice, feedback.kind === 'error' && styles.errorNotice]}
          testID="photo-selection-notice"
        >
          {feedback.message}
        </Text>
      ) : null}

      {progress ? (
        <View
          accessible={active}
          accessibilityLabel={active ? progress : undefined}
          accessibilityLiveRegion={active ? 'polite' : 'none'}
          accessibilityRole={active ? 'progressbar' : undefined}
          accessibilityValue={progressValue}
          style={styles.progressRow}
          testID="photo-selection-progress"
        >
          {active ? <ActivityIndicator color={colors.primary} /> : null}
          <Text accessible={!active} style={styles.progress}>
            {progress}
          </Text>
        </View>
      ) : null}

      {counts ? (
        <Text
          accessibilityLiveRegion={active ? 'none' : 'polite'}
          style={styles.progress}
          testID="photo-save-counts"
        >
          {counts}
        </Text>
      ) : null}

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={active ? 'Cancel saving photos' : 'Exit selection'}
          accessibilityState={{ disabled: stopping }}
          disabled={stopping}
          onPress={active ? onCancelSave : onExit}
          style={styles.action}
        >
          <Text style={[styles.actionText, stopping && styles.disabled]}>
            {active ? 'Cancel' : 'Close'}
          </Text>
        </Pressable>

        <Text accessibilityLiveRegion="polite" style={styles.count} testID="photo-selection-count">
          {atCap ? `${PHOTO_SAVE_SELECTION_MAX} selected (maximum)` : `${selectedCount} selected`}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selectLabel}
          accessibilityState={{ disabled: active || hasSession || atCap }}
          disabled={active || hasSession || atCap}
          onPress={onSelectLoaded}
          style={styles.action}
        >
          <Text style={[styles.actionText, (active || hasSession || atCap) && styles.disabled]}>
            {selectLabel}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.helper}>You can save up to 100 photos at a time.</Text>

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear selection"
          accessibilityState={{ disabled: selectedCount === 0 || active }}
          disabled={selectedCount === 0 || active}
          onPress={onClear}
          style={styles.action}
        >
          <Text style={[styles.actionText, (selectedCount === 0 || active) && styles.disabled]}>
            Clear
          </Text>
        </Pressable>

        {showSettings ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open Settings"
            onPress={onOpenSettings}
            style={styles.action}
          >
            <Text style={styles.actionText}>Settings</Text>
          </Pressable>
        ) : null}

        {!active ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={primaryLabel}
            accessibilityState={{ disabled: selectedCount === 0 }}
            disabled={selectedCount === 0}
            onPress={onSave}
            style={styles.action}
            testID="photo-selection-save"
          >
            <Text style={[styles.actionText, selectedCount === 0 && styles.disabled]}>
              {primaryLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    bottom: 0,
    gap: spacing.xs,
    left: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    paddingTop: spacing.sm,
    position: 'absolute',
    right: 0,
  },
  row: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  progressRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  progress: { ...typography.caption, color: colors.textMuted },
  notice: { ...typography.caption, color: colors.text },
  errorNotice: { color: colors.warning },
  helper: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  count: { ...typography.label, color: colors.text },
  action: { justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.sm },
  actionText: { ...typography.label, color: colors.primary },
  disabled: { color: colors.textMuted },
});
