import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { setAccessToken } from '@/shared/api/token-store';
import { AuthenticatedImage } from '../AuthenticatedImage';
import {
  __resetPrivateMediaLifecycleForTests,
  flushPrivateMediaPurge,
  resumePrivateMediaSession,
  startPrivateMediaSession,
  suspendPrivateMediaSession,
} from '../privateMediaLifecycle';
import {
  __getProtectedAssetEntriesForTests,
  __resetProtectedAssetStoreForTests,
} from '../protectedAssetStore';
import type { ProtectedAssetVariant } from '../protectedAssetTypes';
import {
  bytes,
  createDeferred,
  createFakeTransport,
  imageResponse,
  jsonErrorResponse,
} from '@test/fakeProtectedTransport';

jest.mock('@/shared/api/refresh', () => ({
  refreshTokens: jest.fn(async () => 'token'),
}));

// A prop-forwarding stand-in: the assertions below are about what this component
// hands to expo-image — the local uri, `cachePolicy`, `recyclingKey` — and the
// real native view exposes none of them.
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  const { createElement } = jest.requireActual('react');
  return {
    Image: (props: Record<string, unknown>) => createElement(View, props),
  };
});

const THUMBNAIL: ProtectedAssetVariant = {
  name: 'thumbnail',
  bucket: 'thumbnail',
  maxBytes: 4 * 1024 * 1024,
};

const ASSET_KEY = 'trip-photo:trip-1:photo-1:thumbnail';
const PATH = '/trips/trip-1/photos/photo-1/thumbnail';

async function renderImage(
  transport: ReturnType<typeof createFakeTransport>,
  overrides: Partial<React.ComponentProps<typeof AuthenticatedImage>> = {},
) {
  return render(
    <AuthenticatedImage
      assetKey={ASSET_KEY}
      path={PATH}
      variant={THUMBNAIL}
      width={110}
      height={110}
      contentFit="cover"
      accessibilityLabel="Open photo uploaded by Mai"
      transport={transport}
      {...overrides}
    />,
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetPrivateMediaLifecycleForTests();
  __resetProtectedAssetStoreForTests();
  setAccessToken('token');
  await startPrivateMediaSession();
});

afterEach(() => {
  setAccessToken(null);
});

describe('rendering', () => {
  it('reserves the tile size before the asset resolves', async () => {
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async () => {
      await gate.promise;
      return imageResponse([bytes(16)]).response;
    });

    await renderImage(transport);

    const placeholder = await screen.findByTestId(`authenticated-image-placeholder-${ASSET_KEY}`);
    expect(placeholder.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 110, height: 110 })]),
    );

    await act(async () => {
      gate.resolve();
    });
  });

  it('renders the staged local file with a memory-only cache policy', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    await renderImage(transport, { sourceWidth: 480, sourceHeight: 320 });

    const image = await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(image.props.source.uri.startsWith('file:///')).toBe(true);
    expect(image.props.source).toMatchObject({ width: 480, height: 320 });
    expect(image.props.recyclingKey).toBe(ASSET_KEY);
    expect(image.props.accessibilityLabel).toBe('Open photo uploaded by Mai');
  });

  it('never uses a persistent disk cache for member-only content (D3)', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    await renderImage(transport);

    const image = await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(image.props.cachePolicy).toBe('memory');
    expect(['disk', 'memory-disk']).not.toContain(image.props.cachePolicy);
  });
});

describe('error states', () => {
  it('reports a 404 to the owner with its error code so trip-level can be told from photo-level', async () => {
    const onNotFound = jest.fn();
    const transport = createFakeTransport(
      () => jsonErrorResponse(404, { detail: 'Trip not found.', error_code: 'TRIP_NOT_FOUND' }).response,
    );

    await renderImage(transport, { onNotFound });

    await screen.findByTestId(`authenticated-image-error-${ASSET_KEY}`);
    expect(onNotFound).toHaveBeenCalledTimes(1);
    expect(onNotFound.mock.calls[0][0]).toMatchObject({
      kind: 'notFound',
      errorCode: 'TRIP_NOT_FOUND',
    });
  });

  it('shows a neutral unavailable state that leaks no path', async () => {
    const transport = createFakeTransport(
      () => jsonErrorResponse(404, { detail: 'Photo not found.', error_code: 'PHOTO_NOT_FOUND' }).response,
    );

    await renderImage(transport);

    await screen.findByTestId(`authenticated-image-error-${ASSET_KEY}`);
    expect(screen.getByLabelText('Image unavailable')).toBeTruthy();
    // The neutral state must not echo the path or the backend's wording back at
    // the user: a broken tile says nothing about what it was pointing at.
    expect(screen.queryByText('Photo not found.')).toBeNull();
    expect(screen.queryByText(PATH)).toBeNull();
  });

  it('offers a retry on a network failure', async () => {
    const transport = createFakeTransport(() => {
      throw new Error('offline');
    });

    await renderImage(transport);

    expect(await screen.findByLabelText('Retry loading this image')).toBeTruthy();
  });

  it('offers no retry on a 404, because retrying a deleted photo cannot help', async () => {
    const transport = createFakeTransport(() => jsonErrorResponse(404, { detail: 'gone' }).response);

    await renderImage(transport);

    await screen.findByTestId(`authenticated-image-error-${ASSET_KEY}`);
    expect(screen.queryByLabelText('Retry loading this image')).toBeNull();
  });

  it('retries the load when the user asks', async () => {
    let shouldFail = true;
    const transport = createFakeTransport(() => {
      if (shouldFail) {
        throw new Error('offline');
      }
      return imageResponse([bytes(16)]).response;
    });

    await renderImage(transport);
    const retry = await screen.findByLabelText('Retry loading this image');

    shouldFail = false;
    await act(async () => {
      await fireEvent.press(retry);
    });

    await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(transport.fetches.calls).toHaveLength(2);
  });

  it('reacquires exactly once when the staged file disappears before decode', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    await renderImage(transport);
    const image = await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);

    await act(async () => {
      await fireEvent(image, 'error', { error: 'file missing' });
    });
    await waitFor(() => expect(transport.fetches.calls).toHaveLength(2));

    // A second decode failure is a broken file, not a missing one: stop instead
    // of looping.
    const retriedImage = await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);
    await act(async () => {
      await fireEvent(retriedImage, 'error', { error: 'still broken' });
    });

    await screen.findByTestId(`authenticated-image-error-${ASSET_KEY}`);
    expect(transport.fetches.calls).toHaveLength(2);
  });
});

describe('session lifecycle', () => {
  it('drops the local uri on a background purge and only reacquires after foreground', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    await renderImage(transport);
    await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(transport.fetches.calls).toHaveLength(1);

    await act(async () => {
      suspendPrivateMediaSession();
      await flushPrivateMediaPurge();
    });

    // Backgrounded: the file is gone and nothing was requested to replace it.
    await screen.findByTestId(`authenticated-image-placeholder-${ASSET_KEY}`);
    expect(transport.fetches.calls).toHaveLength(1);

    await act(async () => {
      await resumePrivateMediaSession();
    });

    await screen.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(transport.fetches.calls).toHaveLength(2);
  });

  it('releases its reference on unmount so the entry becomes evictable', async () => {
    const transport = createFakeTransport(() => imageResponse([bytes(16)]).response);

    const mounted = await renderImage(transport);
    await mounted.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(__getProtectedAssetEntriesForTests()[0].refCount).toBe(1);

    await act(async () => {
      mounted.unmount();
    });

    // Unpinned, but still on disk: releasing is not deleting (D3).
    expect(__getProtectedAssetEntriesForTests()[0].refCount).toBe(0);

    const remounted = await renderImage(transport);
    await remounted.findByTestId(`authenticated-image-${ASSET_KEY}`);
    expect(transport.fetches.calls).toHaveLength(1);
  });

  it('abandons a load whose only consumer unmounted, staging nothing', async () => {
    const gate = createDeferred<void>();
    const transport = createFakeTransport(async () => {
      await gate.promise;
      return imageResponse([bytes(16)]).response;
    });

    const mounted = await renderImage(transport);
    await mounted.findByTestId(`authenticated-image-placeholder-${ASSET_KEY}`);
    await act(async () => {
      mounted.unmount();
    });

    await act(async () => {
      gate.resolve();
    });

    // The last interested consumer left before the response arrived, so the
    // load was cancelled: no registry entry, no file, and no setState against an
    // unmounted tree.
    expect(__getProtectedAssetEntriesForTests()).toHaveLength(0);
    expect(transport.files.contents().size).toBe(0);
  });
});
