import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { PHOTO_BULK_DOWNLOAD_MAX_SELECTION } from '../constants';
import type { SelectionDownloadState } from '../hooks/usePhotoSelection';

interface PhotoSelectionBarProps {
  selectedCount: number;
  /** Drives "Select loaded" vs "Select all": more pages may exist. */
  hasNextPage: boolean;
  download: SelectionDownloadState;
  onSelectLoaded: () => void;
  onClear: () => void;
  onExit: () => void;
  onDownload: () => void;
  onCancelDownload: () => void;
  onHeightChange?: (height: number) => void;
}

function progressLabel(download: SelectionDownloadState): string | null {
  if (download.status !== 'downloading') {
    return null;
  }
  if (download.totalBytes === null) {
    // A streaming ZIP normally has no Content-Length, so indeterminate is the
    // usual case rather than the exception.
    return 'Preparing download…';
  }
  const percent = Math.min(100, Math.round((download.bytesWritten / download.totalBytes) * 100));
  return `Preparing download… ${percent}%`;
}

export function PhotoSelectionBar({
  selectedCount,
  hasNextPage,
  download,
  onSelectLoaded,
  onClear,
  onExit,
  onDownload,
  onCancelDownload,
  onHeightChange,
}: PhotoSelectionBarProps) {
  const downloading = download.status === 'downloading';
  const progress = progressLabel(download);
  const atCap = selectedCount >= PHOTO_BULK_DOWNLOAD_MAX_SELECTION;

  return (
    <View
      style={styles.bar}
      onLayout={(event: LayoutChangeEvent) => onHeightChange?.(event.nativeEvent.layout.height)}
      testID="photo-selection-bar"
    >
      {download.status === 'message' || download.status === 'error' ? (
        <Text style={styles.notice} testID="photo-selection-notice">
          {download.status === 'message' ? download.message : download.failure.message}
        </Text>
      ) : null}

      {progress ? (
        <View style={styles.progressRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.progress}>{progress}</Text>
        </View>
      ) : null}

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit selection"
          onPress={onExit}
          style={styles.action}
        >
          <Text style={styles.actionText}>Cancel</Text>
        </Pressable>

        <Text
          accessibilityLiveRegion="polite"
          style={styles.count}
          testID="photo-selection-count"
        >
          {atCap ? PHOTO_ERROR_MESSAGES_SELECTION_CAP : `${selectedCount} selected`}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasNextPage ? 'Select loaded photos' : 'Select all photos'}
          accessibilityState={{ disabled: downloading }}
          disabled={downloading}
          onPress={onSelectLoaded}
          style={styles.action}
        >
          <Text style={[styles.actionText, downloading && styles.disabled]}>
            {hasNextPage ? 'Select loaded' : 'Select all'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear selection"
          accessibilityState={{ disabled: selectedCount === 0 || downloading }}
          disabled={selectedCount === 0 || downloading}
          onPress={onClear}
          style={styles.action}
        >
          <Text
            style={[
              styles.actionText,
              (selectedCount === 0 || downloading) && styles.disabled,
            ]}
          >
            Clear
          </Text>
        </Pressable>

        {downloading ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel download"
            onPress={onCancelDownload}
            style={styles.action}
          >
            <Text style={styles.actionText}>Cancel download</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Download selected photos"
            accessibilityState={{ disabled: selectedCount === 0 }}
            disabled={selectedCount === 0}
            onPress={onDownload}
            style={styles.action}
            testID="photo-selection-download"
          >
            <Text style={[styles.actionText, selectedCount === 0 && styles.disabled]}>
              Download ZIP
            </Text>
          </Pressable>
        )}
      </View>
      {/* No bulk delete: the backend has no bulk-delete endpoint, and looping
          single deletes would be neither atomic nor within the 120/hour budget. */}
    </View>
  );
}

const PHOTO_ERROR_MESSAGES_SELECTION_CAP = `${PHOTO_BULK_DOWNLOAD_MAX_SELECTION} selected (maximum)`;

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
  notice: { ...typography.caption, color: colors.warning },
  count: { ...typography.label, color: colors.text },
  action: { justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.sm },
  actionText: { ...typography.label, color: colors.primary },
  disabled: { color: colors.textMuted },
});
