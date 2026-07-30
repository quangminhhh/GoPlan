import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import {
  PHOTO_GRID_GAP,
  PHOTO_GRID_MIN_COLUMNS,
  PHOTO_GRID_TARGET_TILE_WIDTH,
} from '../constants';
import type { PhotoFailure } from '../errors';
import type { TripPhoto } from '../types';
import { PhotoTile } from './PhotoTile';

export interface PhotoGridLayout {
  columnCount: number;
  tileSize: number;
}

/**
 * Column count comes from the viewport, with a floor of three.
 *
 * At 375 pt — the narrowest supported width — `floor(375 / 110)` is already 3,
 * so the floor is a guard rather than the usual path, and a wider screen simply
 * gets more columns.
 */
export function computePhotoGridLayout(
  width: number,
  horizontalInset = 0,
  gap: number = PHOTO_GRID_GAP,
  targetTileWidth: number = PHOTO_GRID_TARGET_TILE_WIDTH,
): PhotoGridLayout {
  const columnCount = Math.max(PHOTO_GRID_MIN_COLUMNS, Math.floor(width / targetTileWidth));
  const available = width - horizontalInset - gap * (columnCount - 1);
  return { columnCount, tileSize: Math.max(1, Math.floor(available / columnCount)) };
}

interface PhotoGridProps {
  tripId: string;
  photos: TripPhoto[];
  refreshing: boolean;
  loadingMore: boolean;
  hasNextPage: boolean;
  /** Set only when the failure belongs to pagination; pages stay on screen. */
  pageError: PhotoFailure | null;
  onRefresh: () => void;
  onEndReached: () => void;
  onRetryPage: () => void;
  onPhotoPress: (photoId: string) => void;
  onPhotoLongPress?: (photoId: string) => void;
  onAssetNotFound: (photoId: string, failure: PhotoFailure) => void;
  ListHeaderComponent?: React.ReactElement | null;
}

export function PhotoGrid({
  tripId,
  photos,
  refreshing,
  loadingMore,
  hasNextPage,
  pageError,
  onRefresh,
  onEndReached,
  onRetryPage,
  onPhotoPress,
  onPhotoLongPress,
  onAssetNotFound,
  ListHeaderComponent,
}: PhotoGridProps) {
  const { width } = useWindowDimensions();
  const { columnCount, tileSize } = useMemo(() => computePhotoGridLayout(width), [width]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TripPhoto>) => (
      <PhotoTile
        tripId={tripId}
        photoId={item.id}
        size={tileSize}
        thumbnailWidth={item.thumbnail_width}
        thumbnailHeight={item.thumbnail_height}
        uploaderName={item.uploaded_by.display_name}
        onPress={onPhotoPress}
        onLongPress={onPhotoLongPress}
        onAssetNotFound={onAssetNotFound}
      />
    ),
    [tripId, tileSize, onPhotoPress, onPhotoLongPress, onAssetNotFound],
  );

  const keyExtractor = useCallback((item: TripPhoto) => item.id, []);

  const footer = useMemo(() => {
    if (pageError) {
      return (
        <View style={styles.footer} testID="photo-grid-page-error">
          <Text style={styles.footerText}>{pageError.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading more photos"
            onPress={onRetryPage}
            style={styles.footerAction}
          >
            <Text style={styles.footerActionText}>Retry</Text>
          </Pressable>
        </View>
      );
    }
    if (loadingMore) {
      return (
        <View style={styles.footer} testID="photo-grid-loading-more">
          <ActivityIndicator color={colors.textMuted} />
        </View>
      );
    }
    if (!hasNextPage && photos.length > 0) {
      return <View style={styles.footerSpacer} />;
    }
    return null;
  }, [pageError, loadingMore, hasNextPage, photos.length, onRetryPage]);

  return (
    <FlatList
      testID="photo-grid"
      data={photos}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      numColumns={columnCount}
      // React Native refuses to change `numColumns` on a mounted list, so a
      // rotation or split-view resize has to remount it.
      key={`photo-grid-${columnCount}`}
      columnWrapperStyle={columnCount > 1 ? styles.row : undefined}
      contentContainerStyle={styles.content}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.4}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={footer}
      // `removeClippedSubviews` is intentionally left off until simulator QA
      // says it helps: on iOS it has a history of blanking cells.
      removeClippedSubviews={false}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  row: { gap: PHOTO_GRID_GAP, marginBottom: PHOTO_GRID_GAP },
  footer: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  footerSpacer: { height: spacing.lg },
  footerText: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  footerAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  footerActionText: { ...typography.label, color: colors.primary },
});
