import { memo, useCallback } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { AuthenticatedImage } from '@/shared/media/AuthenticatedImage';
import type { ProtectedAssetError } from '@/shared/media/protectedAssetTypes';
import { colors, radii } from '@/shared/theme/tokens';
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
}: PhotoTileProps) {
  const handlePress = useCallback(() => onPress(photoId), [onPress, photoId]);
  const handleLongPress = useCallback(() => onLongPress?.(photoId), [onLongPress, photoId]);
  const handleNotFound = useCallback(
    (error: ProtectedAssetError) => onAssetNotFound(photoId, toPhotoFailure(error)),
    [onAssetNotFound, photoId],
  );

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open photo uploaded by ${uploaderName}`}
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
});
