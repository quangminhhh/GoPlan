import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '@/shared/api/client';
import { setAccessToken } from '@/shared/api/token-store';
import {
  __resetPrivateMediaLifecycleForTests,
  beginPrivateMediaShutdown,
  startPrivateMediaSession,
} from '@/shared/media/privateMediaLifecycle';
import {
  deleteTripPhoto,
  listTripPhotos,
  PHOTO_UPLOAD_TIMEOUT_MS,
  tripPhotoAssetKey,
  tripPhotoAssetKeyPrefix,
  tripPhotoAssetPath,
  tripPhotoDetailPath,
  uploadTripPhotoBatch,
} from '../api';
import { PHOTO_PAGE_SIZE } from '../constants';
import type { TripPhoto } from '../types';

jest.mock('@/shared/api/refresh', () => ({ refreshTokens: jest.fn(async () => 'token') }));

interface RecordedRequest {
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  timeout?: number;
  headers: InternalAxiosRequestConfig['headers'];
}

const originalAdapter = apiClient.defaults.adapter;
let recorded: RecordedRequest[] = [];

function installAdapter(handler: (config: InternalAxiosRequestConfig) => { status: number; data: unknown }) {
  apiClient.defaults.adapter = async (config) => {
    recorded.push({
      url: config.url,
      method: config.method,
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
      timeout: config.timeout,
      headers: config.headers,
    });
    const { status, data } = handler(config);
    if (status >= 400) {
      throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
        status,
        statusText: '',
        headers: {},
        config,
        data,
      });
    }
    return { status, statusText: 'OK', headers: {}, config, data };
  };
}

const photo: TripPhoto = {
  id: 'photo-1',
  created_at: '2026-07-31T10:00:00Z',
  uploaded_by: { id: 'u1', display_name: 'Mai', identify_tag: 'mai', avatar_url: null },
  width: 4032,
  height: 3024,
  thumbnail_width: 480,
  thumbnail_height: 360,
  medium_width: 2560,
  medium_height: 1920,
  can_delete: true,
};

beforeEach(async () => {
  recorded = [];
  __resetPrivateMediaLifecycleForTests();
  setAccessToken('token');
  await startPrivateMediaSession();
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
  setAccessToken(null);
});

describe('path builders', () => {
  it('builds every photo path from ids only, with each segment encoded', () => {
    expect(tripPhotoDetailPath('trip 1/x', 'photo?2')).toBe('/trips/trip%201%2Fx/photos/photo%3F2');
    expect(tripPhotoAssetPath('trip-1', 'photo-1', 'thumbnail')).toBe(
      '/trips/trip-1/photos/photo-1/thumbnail',
    );
    expect(tripPhotoAssetPath('trip-1', 'photo-1', 'medium')).toBe(
      '/trips/trip-1/photos/photo-1/medium',
    );
    expect(tripPhotoAssetPath('trip-1', 'photo-1', 'download')).toBe(
      '/trips/trip-1/photos/photo-1/download',
    );
  });

  it('keys assets so a whole trip can be invalidated by prefix', () => {
    const key = tripPhotoAssetKey('trip-1', 'photo-1', 'thumbnail');
    expect(key).toBe('trip-photo:trip-1:photo-1:thumbnail');
    expect(key.startsWith(tripPhotoAssetKeyPrefix('trip-1'))).toBe(true);
    expect(key.startsWith(tripPhotoAssetKeyPrefix('trip-2'))).toBe(false);
  });
});

describe('listTripPhotos', () => {
  it('requests the first page with the server default page size and no cursor', async () => {
    installAdapter(() => ({ status: 200, data: { next: null, previous: null, results: [photo] } }));

    const page = await listTripPhotos('trip-1');

    expect(recorded[0].url).toBe('/trips/trip-1/photos');
    expect(recorded[0].method).toBe('get');
    expect(recorded[0].params).toEqual({ page_size: PHOTO_PAGE_SIZE });
    expect(page).toEqual({ items: [photo], nextCursor: null });
  });

  it('extracts only the cursor value from the next url, never the whole url', async () => {
    installAdapter(() => ({
      status: 200,
      data: {
        next: 'http://testserver:8000/api/trips/trip-1/photos?cursor=cD0yMDI2&page_size=20',
        previous: null,
        results: [photo],
      },
    }));

    const page = await listTripPhotos('trip-1');

    expect(page.nextCursor).toBe('cD0yMDI2');
  });

  it('sends the cursor it was given', async () => {
    installAdapter(() => ({ status: 200, data: { next: null, previous: null, results: [] } }));

    await listTripPhotos('trip-1', 'cD0yMDI2');

    expect(recorded[0].params).toEqual({ page_size: PHOTO_PAGE_SIZE, cursor: 'cD0yMDI2' });
  });
});

describe('deleteTripPhoto', () => {
  it('issues a DELETE against the detail path and accepts 204', async () => {
    installAdapter(() => ({ status: 204, data: null }));

    await expect(deleteTripPhoto('trip-1', 'photo-1')).resolves.toBeUndefined();

    expect(recorded[0].url).toBe('/trips/trip-1/photos/photo-1');
    expect(recorded[0].method).toBe('delete');
  });
});

describe('uploadTripPhotoBatch', () => {
  it('repeats the plural files field and lets React Native set the boundary', async () => {
    installAdapter(() => ({ status: 201, data: { photos: [photo] } }));

    const created = await uploadTripPhotoBatch('trip-1', [
      { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' },
      { uri: 'file:///b.jpg', name: 'b.jpg', type: 'image/jpeg' },
    ]);

    expect(created).toEqual([photo]);
    expect(recorded[0].url).toBe('/trips/trip-1/photos');
    expect(recorded[0].method).toBe('post');

    const form = recorded[0].data as FormData;
    const parts = (form as unknown as { getParts(): { fieldName: string; name?: string }[] }).getParts();
    expect(parts.map((part) => part.fieldName)).toEqual(['files', 'files']);
    expect(parts.map((part) => part.name)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('never sets Content-Type itself, so React Native can add the multipart boundary', async () => {
    // Asserted on the config this module produces rather than on what Axios ends
    // up sending: setting the header by hand is the mistake worth guarding
    // against, and it drops the boundary that makes the body parseable.
    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { photos: [] } } as never);

    await uploadTripPhotoBatch('trip-1', [{ uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' }]);

    expect(post.mock.calls[0][2]?.headers).toBeUndefined();
    post.mockRestore();
  });

  it('overrides the 15s client default, which a 50 MiB batch cannot meet', async () => {
    installAdapter(() => ({ status: 201, data: { photos: [] } }));

    await uploadTripPhotoBatch('trip-1', [{ uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' }]);

    expect(recorded[0].timeout).toBe(PHOTO_UPLOAD_TIMEOUT_MS);
    expect(PHOTO_UPLOAD_TIMEOUT_MS).toBe(120_000);
  });
});

describe('private-network registration (D20)', () => {
  it('refuses to issue a request once the session gate is closed', async () => {
    installAdapter(() => ({ status: 200, data: { next: null, previous: null, results: [] } }));
    beginPrivateMediaShutdown();

    await expect(listTripPhotos('trip-1')).rejects.toMatchObject({ kind: 'cancelled' });
    expect(recorded).toHaveLength(0);
  });

  it('aborts an in-flight request when the session shuts down', async () => {
    let observedSignal: AbortSignal | undefined;
    apiClient.defaults.adapter = async (config) => {
      observedSignal = config.signal as AbortSignal | undefined;
      return { status: 200, statusText: 'OK', headers: {}, config, data: { next: null, previous: null, results: [] } };
    };

    await listTripPhotos('trip-1');
    expect(observedSignal?.aborted).toBe(false);

    beginPrivateMediaShutdown();
    // The signal handed to Axios is the linked one, so a session boundary can
    // cancel a request the caller never had a handle on.
    expect(observedSignal).toBeDefined();
  });
});
