export type TimelineActivityTimeMode =
  | 'ALL_DAY'
  | 'FLEXIBLE'
  | 'AT_TIME'
  | 'TIME_RANGE';

export type TimelineActivityStatus =
  | 'UPCOMING'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'CANCELLED';

export type TimelineActivityAssigneeScope = 'NONE' | 'USER' | 'EVERYONE';
export type TimelineLocationMode = 'MANUAL' | 'STRUCTURED';

export type TimelineSystemTypeCode =
  | 'TRANSPORTATION'
  | 'ACCOMMODATION'
  | 'FOOD'
  | 'SIGHTSEEING'
  | 'SHOPPING'
  | 'CHECKIN_OUT'
  | 'FREE_TIME'
  | 'OTHER';

export interface TimelineSystemTypeMeta {
  code: TimelineSystemTypeCode;
  label: string;
  color_token: string;
  icon_key: string;
}

export interface TimelineCustomTypeMeta {
  id: string;
  name: string;
  normalized_name: string;
  color_token: string;
  icon_key: string;
  is_active: boolean;
}

export interface TimelineSystemActivityType {
  kind: 'SYSTEM';
  code: TimelineSystemTypeCode;
  label: string;
  color_token: string;
  icon_key: string;
}

export interface TimelineCustomActivityType {
  kind: 'CUSTOM';
  id: string;
  label: string;
  color_token: string;
  icon_key: string;
}

export type TimelineActivityType =
  | TimelineSystemActivityType
  | TimelineCustomActivityType;

export interface TimelineAssignee {
  id: string;
  display_name: string;
  identify_tag: string | null;
}

export interface TimelinePlace {
  provider: string;
  provider_id: string;
  title: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface TimelineLocation {
  location_mode: TimelineLocationMode;
  location_label: string;
  location_note: string;
  place: TimelinePlace | null;
  open_url: string | null;
}

export interface TimelineActivityCapabilities {
  can_edit: boolean;
  can_delete: boolean;
  can_update_status: boolean;
}

export interface TimelineActivity {
  id: string;
  title: string;
  time_mode: TimelineActivityTimeMode;
  start_time: string | null;
  end_time: string | null;
  status: TimelineActivityStatus;
  position: number;
  activity_type: TimelineActivityType | null;
  assignee_scope: TimelineActivityAssigneeScope;
  assignee: TimelineAssignee | null;
  location: TimelineLocation;
  note: string;
  meeting_point: string;
  contact_name: string;
  contact_phone: string;
  booking_reference: string;
  external_link: string;
  reminder_offsets_minutes: number[];
  capabilities: TimelineActivityCapabilities;
}

export interface TimelineSection {
  id: string;
  section_date: string;
  label: string;
  is_label_custom: boolean;
  is_in_trip_range: boolean;
  position: number;
  activities: TimelineActivity[];
}

export interface TimelinePermissions {
  can_edit_timeline: boolean;
  can_manage_custom_types: boolean;
  can_create_sections: boolean;
}

export interface TimelineResponse {
  trip_timezone: string;
  permissions: TimelinePermissions;
  system_types: TimelineSystemTypeMeta[];
  custom_types: TimelineCustomTypeMeta[];
  sections: TimelineSection[];
}

export interface CreateSectionPayload {
  section_date: string;
  label: string;
}

export type PatchSectionPayload = Partial<CreateSectionPayload>;

export interface ActivityPlacePayload {
  provider: string;
  provider_id: string;
  title: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
}

export interface CreateActivityPayload {
  title: string;
  time_mode: TimelineActivityTimeMode;
  start_time?: string | null;
  end_time?: string | null;
  system_type?: TimelineSystemTypeCode | '';
  custom_type_id?: string | null;
  assignee_scope?: TimelineActivityAssigneeScope;
  assignee_user_id?: string | null;
  location_mode?: TimelineLocationMode;
  location_label?: string;
  location_note?: string;
  place?: ActivityPlacePayload | null;
  note?: string;
  meeting_point?: string;
  contact_name?: string;
  contact_phone?: string;
  booking_reference?: string;
  external_link?: string;
  reminder_offsets_minutes?: number[];
}

export type PatchActivityPayload = Partial<CreateActivityPayload>;

export interface UpdateActivityStatusPayload {
  status: TimelineActivityStatus;
}

export interface UpdateActivityStatusResult {
  activity_id: string;
  status: TimelineActivityStatus;
}

export interface CreateCustomTypePayload {
  name: string;
  color_token?: string;
  icon_key?: string;
}

export type PatchCustomTypePayload = Partial<{
  name: string;
  color_token: string;
  icon_key: string;
  is_active: boolean;
}>;
