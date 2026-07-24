import { useLocalSearchParams } from 'expo-router';
import type { SectionFormRouteIntent } from '../routeIntent';
import { parseSectionFormRouteIntent } from '../routeIntent';
import { RouteReadyState, RouteUnavailableState } from './RouteState';

function ValidSectionFormScreen({ intent }: { intent: SectionFormRouteIntent }) {
  return <RouteReadyState testID={`section-form-${intent.mode}-route-ready`} />;
}

export function SectionFormScreen() {
  const { tripId, mode, sectionId } = useLocalSearchParams();
  const intent = parseSectionFormRouteIntent({ tripId, mode, sectionId });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Form unavailable"
        message="This form link is invalid or incomplete."
      />
    );
  }

  return <ValidSectionFormScreen intent={intent} />;
}
