import { Image } from 'expo-image';
import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { resolveMediaUrl } from '@/shared/api/base-url';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { getInitials } from '@/shared/ui/initials';

export interface FriendAvatarProps {
  displayName: string;
  identifyTag: string;
  avatarUrl: string | null;
}

export const FriendAvatar = memo(function FriendAvatar({
  displayName,
  identifyTag,
  avatarUrl,
}: FriendAvatarProps) {
  const resolvedAvatarUrl = resolveMediaUrl(avatarUrl);
  const imageSource = useMemo(
    () => (resolvedAvatarUrl ? { uri: resolvedAvatarUrl } : null),
    [resolvedAvatarUrl],
  );

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Avatar for ${displayName}, ${identifyTag}`}
      style={styles.avatar}
    >
      {imageSource ? (
        <Image
          source={imageSource}
          recyclingKey={identifyTag}
          style={styles.image}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <Text style={styles.initials}>{getInitials(displayName)}</Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  avatar: {
    width: spacing.lg * 2,
    height: spacing.lg * 2,
    borderRadius: radii.full,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: colors.primarySoft,
  },
  image: { width: '100%', height: '100%' },
  initials: { ...typography.body, color: colors.primary, fontWeight: '700' },
});
