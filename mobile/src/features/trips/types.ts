export type TripStatus = 'PLANNING' | 'ONGOING' | 'COMPLETED' | 'CANCELLED';
export type TripRole = 'CAPTAIN' | 'MEMBER';
export type MemberStatus = 'ACTIVE' | 'LEFT' | 'REMOVED';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';

export interface TripListItem {
  id: string;
  name: string;
  destination: string;
  cover_image_url: string;
  start_date: string;
  end_date: string;
  status: TripStatus;
  currency_code: string;
  budget_estimate: string | null;
  member_count: number;
  my_role: TripRole | null;
}

export interface Trip {
  id: string;
  name: string;
  destination: string;
  destination_provider: string;
  destination_provider_id: string;
  destination_lat: string | null;
  destination_lng: string | null;
  destination_country_code: string;
  cover_image_url: string;
  start_date: string;
  end_date: string;
  description: string;
  status: TripStatus;
  currency_code: string;
  timezone: string;
  budget_estimate: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface TripMemberUser {
  id: string;
  display_name: string;
  identify_tag: string;
  avatar_url: string | null;
}

export interface TripMember {
  membership_id: string;
  user: TripMemberUser;
  role: TripRole;
  joined_at: string;
}

export interface MyMembership {
  role: TripRole;
  status: MemberStatus;
  joined_at: string;
}

export interface TripDetailResponse {
  trip: Trip;
  my_membership: MyMembership;
  members: TripMember[];
}

export interface InvitableFriend {
  id: string;
  display_name: string;
  identify_tag: string;
}

export interface TripInvitation {
  id: string;
  invitee: InvitableFriend;
  status: InvitationStatus;
  created_at: string;
}

export interface TripListPage {
  items: TripListItem[];
  nextCursor: string | null;
}

export interface CreateTripInput {
  name: string;
  destination: string;
  destination_provider?: string;
  destination_provider_id?: string;
  /**
   * Requests carry coordinates as JSON numbers (what the lookup endpoint returns
   * and what the web client forwards). Responses carry them as strings, because
   * Django serialises Decimal that way — hence the asymmetry with `Trip`.
   */
  destination_lat?: number | null;
  destination_lng?: number | null;
  destination_country_code?: string;
  cover_image_url?: string;
  start_date: string;
  end_date: string;
  description?: string;
  currency_code?: string;
  budget_estimate?: string;
}

export interface UpdateTripInput {
  name?: string;
  destination?: string;
  destination_provider?: string;
  destination_provider_id?: string;
  /** Numbers on the request, strings on the response — see CreateTripInput. */
  destination_lat?: number | null;
  destination_lng?: number | null;
  destination_country_code?: string;
  cover_image_url?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
  currency_code?: string;
  timezone?: string;
  budget_estimate?: string | null;
}

export type TripAction = 'start' | 'complete' | 'cancel' | 'leave';
