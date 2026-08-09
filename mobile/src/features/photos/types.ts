/**
 * Trip photo contract, mirroring the serializer in `memories/serializers.py` and
 * the web domain type in `frontend/features/trips/domain/photo-types.ts`.
 *
 * There is deliberately no `url` field: the backend does not send one. Every
 * asset path is built from `tripId + photoId + variant`, so no response value can
 * ever become a request URL.
 */

export interface TripPhotoUser {
  id: string | null;
  display_name: string;
  identify_tag: string | null;
  avatar_url: string | null;
}

export interface TripPhoto {
  id: string;
  created_at: string;
  uploaded_by: TripPhotoUser;
  /** Dimensions of the original upload, before the server's variants. */
  width: number;
  height: number;
  thumbnail_width: number;
  thumbnail_height: number;
  medium_width: number;
  medium_height: number;
  /** Server-computed: uploader or trip captain. Never re-derived on the client. */
  can_delete: boolean;
}

export interface TripPhotoUploadResponse {
  photos: TripPhoto[];
}

/**
 * `download` is a separate throttle scope and sets Content-Disposition, but it
 * serves the stored `medium` file — there is no endpoint for an original (D16).
 */
export type TripPhotoAssetVariantName = 'thumbnail' | 'medium' | 'download';
