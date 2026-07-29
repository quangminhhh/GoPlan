import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { resolveMediaUrl } from '@/shared/api/base-url';
import { colors, radii, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import type { TripCoverStatus } from '../hooks/useTripCoverUpload';

interface CoverImageFieldProps {
  coverUrl: string;
  status: TripCoverStatus;
  error: string | null;
  disabled?: boolean;
  onChoose: () => void;
  onRemove: () => void;
}

export function CoverImageField({
  coverUrl,
  status,
  error,
  disabled = false,
  onChoose,
  onRemove,
}: CoverImageFieldProps) {
  const busy = status !== 'idle';
  const previewUrl = resolveMediaUrl(coverUrl || null);

  return (
    <View style={styles.wrap}>
      {previewUrl ? (
        <Image
          accessibilityLabel="Trip cover preview"
          source={{ uri: previewUrl }}
          style={styles.preview}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View style={styles.placeholder}>
          <Ionicons name="image-outline" size={28} color={colors.textMuted} />
          <Text style={styles.placeholderText}>No cover photo yet</Text>
        </View>
      )}

      {busy ? (
        <View
          accessibilityLabel="Uploading cover"
          accessibilityRole="progressbar"
          style={styles.uploading}
        >
          <ActivityIndicator color={colors.primary} size="small" />
          <Text style={styles.uploadingText}>Uploading cover…</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <View style={styles.action}>
          <Button
            title={coverUrl ? 'Replace photo' : 'Choose photo'}
            variant="secondary"
            onPress={onChoose}
            disabled={disabled || busy}
          />
        </View>
        {coverUrl ? (
          <View style={styles.action}>
            <Button
              title="Remove photo"
              variant="secondary"
              onPress={onRemove}
              disabled={disabled || busy}
            />
          </View>
        ) : null}
      </View>

      {/* Buttons stay enabled behind an error: that is the retry path. */}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  preview: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  placeholder: {
    width: '100%',
    aspectRatio: 16 / 9,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  placeholderText: { ...typography.caption, color: colors.textMuted },
  uploading: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  uploadingText: { ...typography.caption, color: colors.textMuted },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  error: { ...typography.caption, color: colors.danger },
});
