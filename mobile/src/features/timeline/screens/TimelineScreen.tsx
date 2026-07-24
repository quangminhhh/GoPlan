import { useLocalSearchParams } from 'expo-router';
import { parseTimelineRouteIntent } from '../routeIntent';
import { RouteReadyState, RouteUnavailableState } from './RouteState';

export function TimelineScreen() {
  const { tripId } = useLocalSearchParams();
  const intent = parseTimelineRouteIntent({ tripId });

  if (!intent) {
    return (
      <RouteUnavailableState
        title="Timeline unavailable"
        message="This timeline link is invalid or incomplete."
      />
    );
  }

  return <RouteReadyState testID="timeline-route-ready" />;
}
