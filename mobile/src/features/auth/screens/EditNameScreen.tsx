import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { normalizeApiError } from '@/shared/api/errors';
import { colors, spacing, typography } from '@/shared/theme/tokens';
import { Button } from '@/shared/ui/Button';
import { Screen } from '@/shared/ui/Screen';
import { TextField } from '@/shared/ui/TextField';
import { mapProfileNameError, type NameFieldErrors } from '../accountErrors';
import { updateProfileNameRequest } from '../api';
import { describeNameError, NAME_MAX_LENGTH, validateHumanName } from '../nameValidation';
import { useSession } from '../session';

export function EditNameScreen() {
  const { user, updateUser } = useSession();
  const router = useRouter();
  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [errors, setErrors] = useState<NameFieldErrors>({ routeToProfileSetup: false });
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  if (!user) {
    return null;
  }

  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName.trim();
  const dirty = trimmedFirst !== user.first_name || trimmedLast !== user.last_name;

  async function onSubmit() {
    if (submitLockRef.current || !user) {
      return;
    }

    const firstError = validateHumanName(firstName);
    const lastError = validateHumanName(lastName);
    if (firstError || lastError) {
      setErrors({
        firstName: firstError ? describeNameError('First name', firstError) : undefined,
        lastName: lastError ? describeNameError('Last name', lastError) : undefined,
        routeToProfileSetup: false,
      });
      return;
    }

    setErrors({ routeToProfileSetup: false });
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      // The backend rebuilds display_name from the pair, so adopt its whole user.
      updateUser(await updateProfileNameRequest({ first_name: trimmedFirst, last_name: trimmedLast }));
      router.back();
    } catch (caught) {
      const mapped = mapProfileNameError(normalizeApiError(caught));
      if (mapped.routeToProfileSetup) {
        router.replace('/(auth)/profile-setup');
        return;
      }
      setErrors(mapped);
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
            <Button title="Save" onPress={onSubmit} loading={submitting} disabled={!dirty} />
          </>
        }
      >
        <Text style={styles.hint}>
          Your display name is built from these two. Your tag {user.identify_tag} cannot be changed.
        </Text>
        <TextField
          label="First name"
          accessibilityLabel="First name"
          value={firstName}
          onChangeText={setFirstName}
          maxLength={NAME_MAX_LENGTH}
          autoCapitalize="words"
          error={errors.firstName}
        />
        <TextField
          label="Last name"
          accessibilityLabel="Last name"
          value={lastName}
          onChangeText={setLastName}
          maxLength={NAME_MAX_LENGTH}
          autoCapitalize="words"
          error={errors.lastName}
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  hint: { ...typography.body, color: colors.textMuted, marginBottom: spacing.sm },
  formError: { ...typography.body, color: colors.danger },
});
