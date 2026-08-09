import { memo, useCallback, useMemo, useState } from 'react';
import {
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AuthenticatedImage } from '@/shared/media/AuthenticatedImage';
import type { ProtectedAssetError } from '@/shared/media/protectedAssetTypes';
import { colors, radii, spacing } from '@/shared/theme/tokens';
import { tripPhotoAssetKey, tripPhotoAssetKeyPrefix, tripPhotoAssetPath } from '../api';
import { TRIP_PHOTO_VARIANTS } from '../constants';
import { toPhotoFailure, type PhotoFailure } from '../errors';

interface PhotoTileProps {
  tripId: string;
  photoId: string;
  /** Square, fixed before the asset resolves, so the grid never reflows. */
  size: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  uploaderName: string;
  onPress: (photoId: string) => void;
  onLongPress?: (photoId: string) => void;
  onAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
  selectionMode?: boolean;
  selected?: boolean;
}

/**
 * One grid cell.
 *
 * Props are primitives and callbacks take the photo id as an argument, so the
 * parent can keep one stable handler per action and this stays memoised across
 * a scroll.
 */
function PhotoTileComponent({
  tripId,
  photoId,
  size,
  thumbnailWidth,
  thumbnailHeight,
  uploaderName,
  onPress,
  onLongPress,
  onAssetNotFound,
  selectionMode = false,
  selected = false,
}: PhotoTileProps) {
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const handlePress = useCallback(() => onPress(photoId), [onPress, photoId]);
  const handleLongPress = useCallback(() => onLongPress?.(photoId), [onLongPress, photoId]);
  const handleNotFound = useCallback(
    (error: ProtectedAssetError) => onAssetNotFound(photoId, toPhotoFailure(error)),
    [onAssetNotFound, photoId],
  );
  const selectionActionLabel = selectionMode && selected ? 'Deselect photo' : 'Select photo';
  const accessibilityActions = useMemo<AccessibilityActionInfo[]>(
    () => [
      ...(onLongPress || selectionMode
        ? [{ name: 'toggleSelection', label: selectionActionLabel }]
        : []),
      ...(retryAvailable ? [{ name: 'retryImage', label: 'Retry loading photo' }] : []),
    ],
    [onLongPress, retryAvailable, selectionActionLabel, selectionMode],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'retryImage') {
        setRetryKey((current) => current + 1);
        return;
      }
      if (event.nativeEvent.actionName === 'toggleSelection') {
        if (selectionMode) handlePress();
        else handleLongPress();
      }
    },
    [handleLongPress, handlePress, selectionMode],
  );

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={
        selectionMode
          ? `Photo uploaded by ${uploaderName}`
          : `Open photo uploaded by ${uploaderName}`
      }
      accessibilityHint={
        selectionMode
          ? `Double tap to ${selected ? 'deselect' : 'select'} this photo.`
          : 'Double tap to open. Use the Select photo action to enter selection mode.'
      }
      accessibilityState={{ selected: selectionMode && selected }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      style={({ pressed }) => [styles.tile, { width: size, height: size }, pressed && styles.pressed]}
      testID={`photo-tile-${photoId}`}
    >
      <AuthenticatedImage
        assetKey={tripPhotoAssetKey(tripId, photoId, 'thumbnail')}
        invalidationPrefix={tripPhotoAssetKeyPrefix(tripId)}
        path={tripPhotoAssetPath(tripId, photoId, 'thumbnail')}
        variant={TRIP_PHOTO_VARIANTS.thumbnail}
        width={size}
        height={size}
        contentFit="cover"
        accessibilityLabel={`Photo uploaded by ${uploaderName}`}
        accessible={false}
        onRetryAvailabilityChange={setRetryAvailable}
        retryKey={retryKey}
        sourceWidth={thumbnailWidth}
        sourceHeight={thumbnailHeight}
        onNotFound={handleNotFound}
      />
      {selectionMode ? (
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.badge, selected && styles.badgeSelected]}
        >
          {selected ? <Ionicons name="checkmark" size={14} color={colors.background} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export const PhotoTile = memo(PhotoTileComponent);
PhotoTile.displayName = 'PhotoTile';

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.7 },
  badge: {
    alignItems: 'center',
    backgroundColor: colors.mediaSelectionOverlay,
    borderColor: colors.background,
    borderRadius: radii.full,
    borderWidth: 1.5,
    bottom: spacing.xs,
    height: 22,
    justifyContent: 'center',
    position: 'absolute',
    right: spacing.xs,
    width: 22,
  },
  badgeSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
});
