const mockPickImages = jest.fn();
const mockCreateUploadSession = jest.fn();
const mockTrackPrivateRequest = jest.fn();

jest.mock('@/shared/media/pickImage', () => ({
  pickImages: (...args: unknown[]) => mockPickImages(...args),
}));

jest.mock('@/shared/media/imageCodec', () => ({
  nativeImageCodec: { discard: jest.fn(async () => undefined) },
}));

jest.mock('@/shared/media/preprocessImage', () => ({
  preprocessImage: jest.fn(),
}));

jest.mock('@/shared/media/uploadTempStore', () => ({
  adoptUploadTempFile: jest.fn(),
  discardUploadTempFile: jest.fn(async () => undefined),
  uploadTempAvailableBytes: jest.fn(() => 1024 * 1024 * 1024),
}));

jest.mock('@/shared/media/privateMediaLifecycle', () => ({
  ...jest.requireActual('@/shared/media/privateMediaLifecycle'),
  acquirePrivateTransferLease: jest.fn(() => () => undefined),
  trackPrivateRequest: (...args: unknown[]) => mockTrackPrivateRequest(...args),
}));

jest.mock('../api', () => ({
  uploadTripPhotoBatch: jest.fn(),
}));

jest.mock('../uploadSession', () => ({
  createUploadSession: (...args: unknown[]) => mockCreateUploadSession(...args),
}));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { AppState, type AppStateStatus } from 'react-native';
// eslint-disable-next-line import/first
import { createSessionClosedError } from '@/shared/media/privateMediaLifecycle';
// eslint-disable-next-line import/first
import { usePhotoUpload } from '../hooks/usePhotoUpload';
// eslint-disable-next-line import/first
import type {
  UploadSessionController,
  UploadSnapshot,
} from '../uploadSession';

const SELECTED_SNAPSHOT: UploadSnapshot = {
  phase: 'selected',
  items: [],
  selectedCount: 1,
  processedCount: 0,
  uploadedCount: 0,
  rejectedCount: 0,
  pendingCount: 1,
  unknownCount: 0,
  failedCount: 0,
  batchesUploaded: 0,
  currentBatchSize: 0,
  batchBytesSent: 0,
  batchBytesTotal: null,
  error: null,
};

function fakeSession(): jest.Mocked<UploadSessionController> {
  return {
    snapshot: jest.fn(() => SELECTED_SNAPSHOT),
    start: jest.fn(async () => undefined),
    requestStop: jest.fn(),
    requestPause: jest.fn(),
    cancel: jest.fn(async () => undefined),
  };
}

function hookOptions() {
  return {
    tripId: 'trip-1',
    onUploaded: jest.fn(),
    onReconcile: jest.fn(),
    onTripNotFound: jest.fn(),
  };
}

function pickedOutcome() {
  return {
    status: 'picked' as const,
    images: [
      {
        uri: 'file:///picked/photo.heic',
        width: 4032,
        height: 3024,
        fileName: 'IMG_1.HEIC',
      },
    ],
    unreadable: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTrackPrivateRequest.mockImplementation(
    (
      _signal: AbortSignal | undefined,
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => run(new AbortController().signal),
  );
});

it('surfaces a picker rejection and allows a successful retry', async () => {
  const session = fakeSession();
  mockCreateUploadSession.mockReturnValue(session);
  mockPickImages
    .mockRejectedValueOnce(new Error('native picker unavailable'))
    .mockResolvedValueOnce(pickedOutcome());
  const { result } = await renderHook(() => usePhotoUpload(hookOptions()));

  await act(async () => {
    await result.current.pick();
  });

  expect(result.current.picking).toBe(false);
  expect(result.current.pickFailure).toMatchObject({
    kind: 'server',
    message: 'Something went wrong. Please try again.',
  });
  expect(mockCreateUploadSession).not.toHaveBeenCalled();

  await act(async () => {
    await result.current.pick();
  });

  expect(result.current.pickFailure).toBeNull();
  expect(result.current.snapshot).toEqual(SELECTED_SNAPSHOT);
  expect(mockCreateUploadSession).toHaveBeenCalledTimes(1);
});

it('keeps a paused session resumable when the foreground gate is still closed', async () => {
  const session = fakeSession();
  mockCreateUploadSession.mockReturnValue(session);
  mockPickImages.mockResolvedValueOnce(pickedOutcome());
  const { result } = await renderHook(() => usePhotoUpload(hookOptions()));
  await act(async () => {
    await result.current.pick();
  });

  mockTrackPrivateRequest.mockRejectedValueOnce(createSessionClosedError());
  await act(async () => {
    result.current.start();
    await Promise.resolve();
  });
  await waitFor(() => expect(session.cancel).not.toHaveBeenCalled());
  expect(session.start).not.toHaveBeenCalled();

  mockTrackPrivateRequest.mockImplementationOnce(
    (
      _signal: AbortSignal | undefined,
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => run(new AbortController().signal),
  );
  await act(async () => {
    result.current.start();
    await Promise.resolve();
  });

  await waitFor(() => expect(session.start).toHaveBeenCalledTimes(1));
  expect(session.cancel).not.toHaveBeenCalled();
});

it('pauses only for a real background transition, not transient inactive', async () => {
  let appStateListener: ((state: AppStateStatus) => void) | null = null;
  const addEventListener = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
  const session = fakeSession();
  mockCreateUploadSession.mockReturnValue(session);
  mockPickImages.mockResolvedValueOnce(pickedOutcome());
  const { result, unmount } = await renderHook(() => usePhotoUpload(hookOptions()));
  await act(async () => {
    await result.current.pick();
  });

  await act(async () => {
    appStateListener?.('inactive');
  });
  expect(session.requestPause).not.toHaveBeenCalled();

  await act(async () => {
    appStateListener?.('background');
  });
  expect(session.requestPause).toHaveBeenCalledTimes(1);

  await unmount();
  addEventListener.mockRestore();
});
