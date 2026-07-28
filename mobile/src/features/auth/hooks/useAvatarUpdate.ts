import { useCallback, useRef, useState } from 'react';
import { nativeImageCodec } from '@/shared/media/imageCodec';
import { pickImage } from '@/shared/media/pickImage';
import { preprocessImage } from '@/shared/media/preprocessImage';
import { AVATAR_TARGET, describeAvatarError } from '../accountErrors';
import { deleteAvatarRequest, uploadAvatarRequest } from '../api';
import { useSession } from '../session';

export type AvatarStatus = 'idle' | 'picking' | 'uploading' | 'removing';

export interface AvatarUpdate {
  status: AvatarStatus;
  error: string | null;
  changeAvatar: () => Promise<void>;
  removeAvatar: () => Promise<void>;
  dismissError: () => void;
}

export function useAvatarUpdate(): AvatarUpdate {
  const { updateUser } = useSession();
  const [status, setStatus] = useState<AvatarStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  /**
   * `status` only disables the buttons once React has re-rendered, so a fast
   * double tap can enter these callbacks twice and run two uploads whose
   * responses race — the later one silently wins. This ref closes the window
   * synchronously, the same lock the account screens use.
   */
  const busyRef = useRef(false);

  const changeAvatar = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setError(null);
    setStatus('picking');
    try {
      const outcome = await pickImage({ square: true });
      if (outcome.status === 'cancelled') {
        setStatus('idle');
        return;
      }
      setStatus('uploading');
      // Every temp file this flow creates: the picker's full-resolution copy
      // and the encoded upload. Both sit in the cache directory and nothing
      // reads them once the request is done, so without this repeated avatar
      // changes would pile up megabytes there.
      const temporaries = [outcome.image.uri];
      try {
        const file = await preprocessImage(outcome.image, AVATAR_TARGET, nativeImageCodec);
        temporaries.push(file.uri);
        // The response carries the whole user; replace it rather than patching
        // avatar_url, so every derived field stays server-authoritative.
        updateUser(await uploadAvatarRequest(file));
      } finally {
        // Cleanup runs on the failure path too, and must never replace the
        // outcome the user is actually waiting on with a delete error.
        await Promise.all(
          temporaries.map((uri) => nativeImageCodec.discard(uri).catch(() => undefined)),
        );
      }
      setStatus('idle');
    } catch (caught) {
      setStatus('idle');
      setError(describeAvatarError(caught));
    } finally {
      busyRef.current = false;
    }
  }, [updateUser]);

  const removeAvatar = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setError(null);
    setStatus('removing');
    try {
      updateUser(await deleteAvatarRequest());
      setStatus('idle');
    } catch (caught) {
      setStatus('idle');
      setError(describeAvatarError(caught));
    } finally {
      busyRef.current = false;
    }
  }, [updateUser]);

  const dismissError = useCallback(() => setError(null), []);

  return { status, error, changeAvatar, removeAvatar, dismissError };
}
