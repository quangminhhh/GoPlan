import { useLocalSearchParams } from 'expo-router';
import { parseTimelineRouteIntent } from '../routeIntent';
import { RouteReadyState, RouteUnavailableState } from './RouteState';

export function CustomTypeManagerScreen() {
  const { tripId } = useLocalSearchParams();
  const intent = parseTimelineRouteIntent({ tripId });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Custom types unavailable"
        message="This custom types link is invalid or incomplete."
      />
    );
  }

  return <RouteReadyState testID="custom-types-route-ready" />;
}
