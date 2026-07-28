import { apiClient } from '@/shared/api/client';
import type {
  CreateActivityPayload,
  CreateCustomTypePayload,
  CreateSectionPayload,
  PatchActivityPayload,
  PatchCustomTypePayload,
  PatchSectionPayload,
  TimelineActivity,
  TimelineCustomTypeMeta,
  TimelineResponse,
  TimelineSection,
  UpdateActivityStatusPayload,
  UpdateActivityStatusResult,
} from './types';

interface SectionResponse {
  section: TimelineSection;
}

interface ActivityResponse {
  activity: TimelineActivity;
}

interface CustomTypeResponse {
  custom_type: TimelineCustomTypeMeta;
}

export async function getTimeline(
  tripId: string,
  signal?: AbortSignal,
): Promise<TimelineResponse> {
  const { data } = await apiClient.get<TimelineResponse>(
    `/trips/${tripId}/timeline`,
    { signal },
  );
  return data;
}

export async function createSection(
  tripId: string,
  payload: CreateSectionPayload,
): Promise<TimelineSection> {
  const { data } = await apiClient.post<SectionResponse>(
    `/trips/${tripId}/timeline/sections`,
    payload,
  );
  return data.section;
}

export async function patchSection(
  tripId: string,
  sectionId: string,
  payload: PatchSectionPayload,
): Promise<TimelineSection> {
  const { data } = await apiClient.patch<SectionResponse>(
    `/trips/${tripId}/timeline/sections/${sectionId}`,
    payload,
  );
  return data.section;
}

export async function deleteSection(
  tripId: string,
  sectionId: string,
): Promise<void> {
  await apiClient.delete(`/trips/${tripId}/timeline/sections/${sectionId}`);
}

export async function createActivity(
  tripId: string,
  sectionId: string,
  payload: CreateActivityPayload,
): Promise<TimelineActivity> {
  const { data } = await apiClient.post<ActivityResponse>(
    `/trips/${tripId}/timeline/sections/${sectionId}/activities`,
    payload,
  );
  return data.activity;
}

export async function patchActivity(
  tripId: string,
  activityId: string,
  payload: PatchActivityPayload,
): Promise<TimelineActivity> {
  const { data } = await apiClient.patch<ActivityResponse>(
    `/trips/${tripId}/timeline/activities/${activityId}`,
    payload,
  );
  return data.activity;
}

export async function deleteActivity(
  tripId: string,
  activityId: string,
): Promise<void> {
  await apiClient.delete(
    `/trips/${tripId}/timeline/activities/${activityId}`,
  );
}

export async function updateActivityStatus(
  tripId: string,
  activityId: string,
  payload: UpdateActivityStatusPayload,
): Promise<UpdateActivityStatusResult> {
  const { data } = await apiClient.post<UpdateActivityStatusResult>(
    `/trips/${tripId}/timeline/activities/${activityId}/status`,
    payload,
  );
  return data;
}

export async function createCustomType(
  tripId: string,
  payload: CreateCustomTypePayload,
): Promise<TimelineCustomTypeMeta> {
  const { data } = await apiClient.post<CustomTypeResponse>(
    `/trips/${tripId}/timeline/custom-types`,
    payload,
  );
  return data.custom_type;
}

export async function patchCustomType(
  tripId: string,
  typeId: string,
  payload: PatchCustomTypePayload,
): Promise<TimelineCustomTypeMeta> {
  const { data } = await apiClient.patch<CustomTypeResponse>(
    `/trips/${tripId}/timeline/custom-types/${typeId}`,
    payload,
  );
  return data.custom_type;
}

export async function deleteCustomType(
  tripId: string,
  typeId: string,
): Promise<void> {
  await apiClient.delete(`/trips/${tripId}/timeline/custom-types/${typeId}`);
}
