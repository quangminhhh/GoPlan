export type TimelineRouteParam = string | string[] | undefined;

export interface TimelineRouteParams {
  tripId: TimelineRouteParam;
}

export interface SectionFormRouteParams extends TimelineRouteParams {
  mode: TimelineRouteParam;
  sectionId: TimelineRouteParam;
}

export interface ActivityFormRouteParams extends TimelineRouteParams {
  mode: TimelineRouteParam;
  sectionId: TimelineRouteParam;
  activityId: TimelineRouteParam;
}

export interface TimelineRouteIntent {
  tripId: string;
}

export type SectionFormRouteIntent =
  | { mode: 'create'; tripId: string }
  | { mode: 'edit'; tripId: string; sectionId: string };

export type ActivityFormRouteIntent =
  | { mode: 'create'; tripId: string; sectionId: string }
  | { mode: 'edit'; tripId: string; activityId: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value: TimelineRouteParam): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return null;
  }
  return UUID_PATTERN.test(value) ? value : null;
}

export function parseTimelineRouteIntent({
  tripId,
}: TimelineRouteParams): TimelineRouteIntent | null {
  const parsedTripId = parseUuid(tripId);
  return parsedTripId ? { tripId: parsedTripId } : null;
}

export function parseSectionFormRouteIntent({
  tripId,
  mode,
  sectionId,
}: SectionFormRouteParams): SectionFormRouteIntent | null {
  const parsedTripId = parseUuid(tripId);
  if (!parsedTripId || (mode !== 'create' && mode !== 'edit')) {
    return null;
  }

  if (mode === 'create') {
    return sectionId === undefined ? { mode, tripId: parsedTripId } : null;
  }

  const parsedSectionId = parseUuid(sectionId);
  return parsedSectionId
    ? { mode, tripId: parsedTripId, sectionId: parsedSectionId }
    : null;
}

export function parseActivityFormRouteIntent({
  tripId,
  mode,
  sectionId,
  activityId,
}: ActivityFormRouteParams): ActivityFormRouteIntent | null {
  const parsedTripId = parseUuid(tripId);
  if (!parsedTripId || (mode !== 'create' && mode !== 'edit')) {
    return null;
  }

  if (mode === 'create') {
    const parsedSectionId = parseUuid(sectionId);
    return parsedSectionId && activityId === undefined
      ? { mode, tripId: parsedTripId, sectionId: parsedSectionId }
      : null;
  }

  const parsedActivityId = parseUuid(activityId);
  return parsedActivityId && sectionId === undefined
    ? { mode, tripId: parsedTripId, activityId: parsedActivityId }
    : null;
}
