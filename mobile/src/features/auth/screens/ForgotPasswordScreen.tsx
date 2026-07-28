import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { FormError } from '@/shared/ui/FormError';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { requestPasswordResetRequest } from '../api';

/**
 * The backend answers identically whether or not the address has an account, and
 * mobile renders that answer verbatim. Never branch on it: branching would
 * reintroduce exactly the user enumeration the neutral response prevents.
 *
 * Completing the reset happens in the browser via the emailed link (issue #62,
 * decision D3). POST /auth/password-reset/confirm is not called from mobile.
 */
export function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sentDetail, setSentDetail] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  async function onSubmit() {
    if (submitLockRef.current) {
      return;
    }
    submitLockRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const { detail } = await requestPasswordResetRequest(email.trim());
      setSentDetail(detail);
    } catch (caught) {
      setError(normalizeApiError(caught));
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: !submitting }} />
      <Screen scroll>
        <Text style={styles.title}>Reset your password</Text>
        {sentDetail ? (
          <>
            <Text style={styles.info}>{sentDetail}</Text>
            <Text style={styles.body}>
              Open the link in that email to choose a new password, then come back and sign in.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.body}>
              Enter the email you signed up with and we will send a reset link.
            </Text>
            <TextField
              label="Email"
              accessibilityLabel="Email"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              error={error?.fieldErrors?.email}
            />
            <FormError error={error} />
            <Button
              title="Send reset link"
              onPress={onSubmit}
              loading={submitting}
              disabled={!email.trim()}
            />
          </>
        )}
        <Button
          title="Back to sign in"
          variant="secondary"
          disabled={submitting}
          onPress={() => router.replace('/(auth)/login')}
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginTop: spacing.xl },
  body: { ...typography.body, color: colors.textMuted },
  info: { ...typography.body, color: colors.success },
});
