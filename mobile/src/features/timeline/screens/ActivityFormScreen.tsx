import { useLocalSearchParams } from 'expo-router';
import type { ActivityFormRouteIntent } from '../routeIntent';
import { parseActivityFormRouteIntent } from '../routeIntent';
import { RouteReadyState, RouteUnavailableState } from './RouteState';

function ValidActivityFormScreen({ intent }: { intent: ActivityFormRouteIntent }) {
  return <RouteReadyState testID={`activity-form-${intent.mode}-route-ready`} />;
}

export function ActivityFormScreen() {
  const { tripId, mode, sectionId, activityId } = useLocalSearchParams();
  const intent = parseActivityFormRouteIntent({
    tripId,
    mode,
    sectionId,
    activityId,
  });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Form unavailable"
        message="This form link is invalid or incomplete."
      />
    );
  }

  return <ValidActivityFormScreen intent={intent} />;
}
