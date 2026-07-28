import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { normalizeApiError } from '@/shared/api/errors';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { mapChangePasswordError, type PasswordFieldErrors } from '../accountErrors';
import { changePasswordRequest } from '../api';
import { useSession } from '../session';

/**
 * The three field values below are plaintext passwords. They live in component
 * state only for the lifetime of this screen and go nowhere except the request
 * body: never a log line, never an error message, never a stored value.
 */
export function ChangePasswordScreen() {
  const { rotateSession } = useSession();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<PasswordFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  const canSubmit = Boolean(currentPassword && newPassword && confirmPassword);

  async function onSubmit() {
    if (submitLockRef.current) {
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrors({ newPassword: 'New passwords do not match.' });
      return;
    }

    setErrors({});
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const auth = await changePasswordRequest({
        current_password: currentPassword,
        new_password: newPassword,
      });
      // The server has already revoked every previous token, so the pair in this
      // response must be adopted before anything else can fire a request.
      const outcome = await rotateSession(auth);
      if (outcome === 'signedOut') {
        // The stack guard redirects to login; nothing further to do here.
        return;
      }
      router.back();
    } catch (caught) {
      setErrors(mapChangePasswordError(normalizeApiError(caught)));
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !submitting }} />
      <Screen
        scroll
        footer={
          <>
            {errors.form ? <Text style={styles.formError}>{errors.form}</Text> : null}
            <Button
              title="Change password"
              onPress={onSubmit}
              loading={submitting}
              disabled={!canSubmit}
            />
          </>
        }
      >
        <Text style={styles.hint}>Changing your password signs you out everywhere else.</Text>
        <TextField
          label="Current password"
          accessibilityLabel="Current password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          error={errors.currentPassword}
        />
        <TextField
          label="New password"
          accessibilityLabel="New password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          value={newPassword}
          onChangeText={setNewPassword}
          error={errors.newPassword}
        />
        <TextField
          label="Confirm new password"
          accessibilityLabel="Confirm new password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  hint: { ...typography.body, color: colors.textMuted, marginBottom: spacing.sm },
  formError: { ...typography.body, color: colors.danger },
});
