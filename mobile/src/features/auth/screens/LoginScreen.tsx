import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type ApiError, normalizeApiError } from '@/shared/api/errors';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { FormError } from '@/shared/ui/FormError';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { loginRequest } from '../api';
import { useSession } from '../session';

export function LoginScreen() {
  const { signIn } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    const trimmedEmail = email.trim();
    setError(null);
    setSubmitting(true);
    try {
      const auth = await loginRequest(trimmedEmail, password);
      await signIn(auth);
      router.replace('/');
    } catch (err) {
      const normalized = normalizeApiError(err);
      if (normalized.errorCode === 'EMAIL_NOT_VERIFIED') {
        router.push({ pathname: '/(auth)/verify-email', params: { email: trimmedEmail } });
      } else {
        setError(normalized);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen scroll>
      <Text style={styles.title}>Welcome back</Text>
      <Text style={styles.subtitle}>Sign in to plan your next trip.</Text>
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
      <TextField
        label="Password"
        accessibilityLabel="Password"
        secureTextEntry
        autoComplete="current-password"
        value={password}
        onChangeText={setPassword}
        error={error?.fieldErrors?.password}
      />
      <FormError error={error} />
      <Button title="Sign in" onPress={onSubmit} loading={submitting} disabled={!email.trim() || !password} />
      <Link href="/(auth)/forgot-password" style={styles.forgotLink}>
        Forgot password?
      </Link>
      <View style={styles.footer}>
        <Text style={styles.footerText}>New to GoPlan?</Text>
        <Link href="/(auth)/register" style={styles.footerLink}>
          Create an account
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text, marginTop: spacing.xl },
  subtitle: { ...typography.body, color: colors.textMuted, marginBottom: spacing.md },
  forgotLink: { ...typography.body, color: colors.primary, textAlign: 'center', marginTop: spacing.sm },
  footer: { flexDirection: 'row', gap: spacing.xs, justifyContent: 'center', marginTop: spacing.md },
  footerText: { ...typography.body, color: colors.textMuted },
  footerLink: { ...typography.body, color: colors.primary, fontWeight: '600' },
});
