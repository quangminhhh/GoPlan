import { Image } from 'expo-image';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { resolveMediaUrl } from '@/shared/api/base-url';
import { colors, radii, typography } from '@/shared/theme/tokens';
import { getInitials } from '@/shared/ui/initials';

interface UserAvatarProps {
  displayName: string;
  avatarUrl: string | null;
  size: number;
  accessibilityLabel?: string;
}

export function UserAvatar({
  displayName,
  avatarUrl,
  size,
  accessibilityLabel = 'Your profile picture',
}: UserAvatarProps) {
  const resolved = resolveMediaUrl(avatarUrl);
  const source = useMemo(() => (resolved ? { uri: resolved } : null), [resolved]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.avatar, { width: size, height: size }]}
    >
      {source ? (
        <Image
          testID="user-avatar-image"
          source={source}
          // Backend avatar uploads use a new UUID-backed path, so this key changes
          // after replacement and resets the native image view before reloading.
          recyclingKey={resolved}
          style={styles.image}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <Text style={[styles.initials, { fontSize: size / 3 }]}>{getInitials(displayName)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: radii.full,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: colors.primarySoft,
  },
  image: { width: '100%', height: '100%' },
  initials: { ...typography.heading, color: colors.primary, fontWeight: '700' },
});
