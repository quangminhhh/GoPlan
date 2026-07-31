import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AuthenticatedImage } from '@/shared/media/AuthenticatedImage';
import type { ProtectedAssetError } from '@/shared/media/protectedAssetTypes';
import { colors, radii, spacing } from '@/shared/theme/tokens';
import { tripPhotoAssetKey, tripPhotoAssetPath } from '../api';
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
  const handlePress = useCallback(() => onPress(photoId), [onPress, photoId]);
  const handleLongPress = useCallback(() => onLongPress?.(photoId), [onLongPress, photoId]);
  const handleNotFound = useCallback(
    (error: ProtectedAssetError) => onAssetNotFound(photoId, toPhotoFailure(error)),
    [onAssetNotFound, photoId],
  );

  return (
    <Pressable
      accessibilityRole={selectionMode ? 'checkbox' : 'imagebutton'}
      accessibilityLabel={
        selectionMode
          ? `Photo uploaded by ${uploaderName}`
          : `Open photo uploaded by ${uploaderName}`
      }
      accessibilityState={selectionMode ? { checked: selected } : undefined}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      style={({ pressed }) => [styles.tile, { width: size, height: size }, pressed && styles.pressed]}
      testID={`photo-tile-${photoId}`}
    >
      <AuthenticatedImage
        assetKey={tripPhotoAssetKey(tripId, photoId, 'thumbnail')}
        path={tripPhotoAssetPath(tripId, photoId, 'thumbnail')}
        variant={TRIP_PHOTO_VARIANTS.thumbnail}
        width={size}
        height={size}
        contentFit="cover"
        accessibilityLabel={`Photo uploaded by ${uploaderName}`}
        sourceWidth={thumbnailWidth}
        sourceHeight={thumbnailHeight}
        onNotFound={handleNotFound}
      />
      {selectionMode ? (
        <View style={[styles.badge, selected && styles.badgeSelected]} testID={`photo-tile-check-${photoId}`}>
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
