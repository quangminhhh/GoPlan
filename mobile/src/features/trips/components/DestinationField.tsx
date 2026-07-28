import { StyleSheet, View } from 'react-native';
import { PlacePicker } from '@/shared/location/PlacePicker';
import { spacing } from '@/shared/theme/tokens';
import { TextField } from '@/shared/ui/TextField';
import {
  destinationValueFromPlace,
  manualDestinationValue,
  TRIP_DESTINATION_MAX_LENGTH,
  type TripDestinationValue,
} from '../destination';

interface DestinationFieldProps {
  value: TripDestinationValue;
  disabled?: boolean;
  error?: string;
  onChange: (next: TripDestinationValue) => void;
}

/**
 * The trips-side adapter around the shared picker: it owns the mapping from a
 * neutral ResolvedPlace onto the trip destination model, so neither trip screen
 * repeats it.
 *
 * The manual text field below the picker is what keeps the form submittable when
 * HERE is unavailable — the picker's unavailable/429/network states are advisory,
 * never blocking. Typing there also drops a stale structured place, because a
 * hand-edited label no longer describes the verified one.
 */
export function DestinationField({
  value,
  disabled = false,
  error,
  onChange,
}: DestinationFieldProps) {
  return (
    <View style={styles.wrap}>
      <PlacePicker
        value={{
          label: value.label,
          place: value.place
            ? { title: value.place.label, address: value.place.address }
            : null,
        }}
        disabled={disabled}
        onSelectPlace={(place) => onChange(destinationValueFromPlace(place))}
        onUseManualEntry={(entry) => onChange(manualDestinationValue(entry.label))}
        onLookupFailure={(failure) =>
          onChange(manualDestinationValue(failure.label))
        }
      />
      <TextField
        label="Destination *"
        accessibilityLabel="Destination"
        placeholder="Da Lat, Vietnam"
        value={value.label}
        onChangeText={(text) => onChange(manualDestinationValue(text))}
        maxLength={TRIP_DESTINATION_MAX_LENGTH}
        editable={!disabled}
        error={error}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
});
