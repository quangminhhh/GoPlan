import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { Screen } from '@/shared/ui/Screen';
import { AccountRow } from '../components/AccountRow';
import { UserAvatar } from '../components/UserAvatar';
import { useAvatarUpdate } from '../hooks/useAvatarUpdate';
import { useSession } from '../session';

const AVATAR_SIZE = 96;

function AvatarAction({
  label,
  destructive = false,
  disabled,
  onPress,
}: {
  label: string;
  destructive?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={spacing.sm}
      onPress={disabled ? () => undefined : onPress}
      style={({ pressed }) => [styles.avatarAction, pressed && !disabled && styles.avatarActionPressed]}
    >
      <Text
        style={[
          styles.avatarActionText,
          destructive && styles.avatarActionDestructive,
          disabled && styles.avatarActionDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ProfileScreen() {
  const { user, signOut } = useSession();
  const { status, error, changeAvatar, removeAvatar } = useAvatarUpdate();
  const router = useRouter();

  if (!user) {
    return null;
  }

  const busy = status !== 'idle';
  // Backend's identify_tag is already the full "identify_name#identify_code"
  // value, and there is no rename endpoint, so it stays static text.
  const identify = user.identify_tag;

  function confirmRemoveAvatar() {
    Alert.alert('Remove photo?', 'Your profile picture will be deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeAvatar() },
    ]);
  }

  return (
    <Screen scroll>
      <View style={styles.card}>
        <UserAvatar displayName={user.display_name || user.email} avatarUrl={user.avatar_url} size={AVATAR_SIZE} />
        <Text style={styles.name}>{user.display_name || user.email}</Text>
        <Text style={styles.detail}>{user.email}</Text>
        {identify ? <Text style={styles.detail}>{identify}</Text> : null}
        <View style={styles.avatarActions}>
          <AvatarAction
            label={status === 'uploading' ? 'Uploading…' : 'Change photo'}
            disabled={busy}
            onPress={() => void changeAvatar()}
          />
          {user.avatar_url ? (
            <AvatarAction
              label={status === 'removing' ? 'Removing…' : 'Remove photo'}
              destructive
              disabled={busy}
              onPress={confirmRemoveAvatar}
            />
          ) : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <View style={styles.rows}>
        <AccountRow label="Edit name" onPress={() => router.push('/account/name')} />
        <AccountRow label="Change password" onPress={() => router.push('/account/password')} />
      </View>

      <Button title="Log out" variant="secondary" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  name: { ...typography.heading, color: colors.text, marginTop: spacing.sm },
  detail: { ...typography.body, color: colors.textMuted },
  avatarActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  avatarAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
  avatarActionPressed: { opacity: 0.55 },
  avatarActionText: { ...typography.body, color: colors.primary, fontWeight: '600' },
  avatarActionDestructive: { color: colors.danger },
  avatarActionDisabled: { color: colors.textMuted },
  error: { ...typography.caption, color: colors.danger, textAlign: 'center', marginTop: spacing.sm },
  rows: { gap: spacing.sm },
});
