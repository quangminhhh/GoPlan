import { useCallback, useRef, useState } from 'react';
import { nativeImageCodec } from '@/shared/media/imageCodec';
import { pickImage } from '@/shared/media/pickImage';
import { preprocessImage } from '@/shared/media/preprocessImage';
import { uploadTripCover } from '../api';
import { describeCoverError, TRIP_COVER_TARGET } from '../coverMedia';

export type TripCoverStatus = 'idle' | 'picking' | 'uploading';

export interface TripCoverUpload {
  /** '' means "no cover". Always either '' or a server-returned /media/... URL. */
  coverUrl: string;
  status: TripCoverStatus;
  error: string | null;
  /** True while picking or uploading — the form blocks submit on this. */
  busy: boolean;
  /** True once the user picked or removed; drives "send cover_image_url or omit it". */
  changed: boolean;
  chooseCover: () => Promise<void>;
  removeCover: () => void;
  dismissError: () => void;
}

export function useTripCoverUpload(initialUrl = ''): TripCoverUpload {
  const [coverUrl, setCoverUrl] = useState(initialUrl);
  const [status, setStatus] = useState<TripCoverStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  /**
   * `status` only disables the button once React has re-rendered, so a fast
   * double tap can enter this callback twice and run two uploads whose responses
   * race — the later one silently wins. This ref closes the window synchronously,
   * the same lock the account screens use.
   */
  const busyRef = useRef(false);

  const chooseCover = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setError(null);
    setStatus('picking');
    try {
      // Photo library only (decision D7): a camera photo is reachable through
      // it, and no new native permission or rebuild is involved.
      const outcome = await pickImage({ square: false });
      if (outcome.status === 'cancelled') {
        setStatus('idle');
        return;
      }
      setStatus('uploading');
      // Every temp file this flow creates: the picker's full-resolution copy and
      // the encoded upload. Both sit in the cache directory and nothing reads
      // them once the request is done.
      const temporaries = [outcome.image.uri];
      let uploadedUrl: string;
      try {
        const file = await preprocessImage(outcome.image, TRIP_COVER_TARGET, nativeImageCodec);
        temporaries.push(file.uri);
        uploadedUrl = await uploadTripCover(file);
      } finally {
        // Cleanup runs on the failure path too, and must never replace the
        // outcome the user is actually waiting on with a delete error.
        await Promise.all(
          temporaries.map((uri) => nativeImageCodec.discard(uri).catch(() => undefined)),
        );
      }
      // The only legal source of a cover_image_url is this response.
      setCoverUrl(uploadedUrl);
      setChanged(true);
      setStatus('idle');
    } catch (caught) {
      setStatus('idle');
      setError(describeCoverError(caught));
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** No delete endpoint exists; clearing the field is what removes the cover. */
  const removeCover = useCallback(() => {
    setError(null);
    setCoverUrl('');
    setChanged(true);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    coverUrl,
    status,
    error,
    busy: status !== 'idle',
    changed,
    chooseCover,
    removeCover,
    dismissError,
  };
}
