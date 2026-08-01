const mockPickImages = jest.fn();
const mockCreateUploadSession = jest.fn();
const mockTrackPrivateRequest = jest.fn();
const mockDiscardPickerSource = jest.fn(async (_uri: string) => undefined);
const mockDiscardPickerSources = jest.fn(async (_uris: Iterable<string | null>) => undefined);
let mockAuthTicket = { sessionGeneration: 1, credentialRevision: 0 };
let mockAuthCurrent = true;
const mockAuthListeners = new Set<() => void>();

jest.mock('@/shared/api/authSessionLifecycle', () => ({
  captureAuthTicket: jest.fn(() => (mockAuthCurrent ? mockAuthTicket : null)),
  isAuthTicketCurrent: jest.fn((ticket: typeof mockAuthTicket) =>
    mockAuthCurrent &&
    ticket.sessionGeneration === mockAuthTicket.sessionGeneration &&
    ticket.credentialRevision === mockAuthTicket.credentialRevision,
  ),
  subscribeAuthLifecycle: jest.fn((listener: () => void) => {
    mockAuthListeners.add(listener);
    return () => mockAuthListeners.delete(listener);
  }),
}));

jest.mock('@/shared/media/pickImage', () => ({
  pickImages: (...args: unknown[]) => mockPickImages(...args),
}));

jest.mock('@/shared/media/imageCodec', () => ({
  nativeImageCodec: { discard: jest.fn(async () => undefined) },
}));

jest.mock('@/shared/media/preprocessImage', () => ({
  preprocessImage: jest.fn(),
}));

jest.mock('@/shared/media/pickerSourceStore', () => ({
  discardAppOwnedPickerSource: (uri: string) => mockDiscardPickerSource(uri),
  discardAppOwnedPickerSources: (uris: Iterable<string | null>) =>
    mockDiscardPickerSources(uris),
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
import { createDeferred } from '@test/fakeProtectedTransport';
// eslint-disable-next-line import/first
import { createSessionClosedError } from '@/shared/media/privateMediaLifecycle';
// eslint-disable-next-line import/first
import { usePhotoUpload } from '../hooks/usePhotoUpload';
// eslint-disable-next-line import/first
import { uploadCleanupCoordinator } from '../uploadCleanupCoordinator';
// eslint-disable-next-line import/first
import type {
  UploadSessionController,
  UploadSnapshot,
} from '../uploadSession';
// eslint-disable-next-line import/first
import type { TripPhotoScope } from '../hooks/useTripPhotoScope';

const SCOPE_TICKET = { tripId: 'trip-1', generation: 0 };
const TEST_SCOPE: TripPhotoScope = {
  capture: () => SCOPE_TICKET,
  isCurrent: (ticket) =>
    ticket.tripId === SCOPE_TICKET.tripId && ticket.generation === SCOPE_TICKET.generation,
  subscribeInvalidation: () => () => undefined,
  waitForCleanup: async () => undefined,
};

function createScopeHarness() {
  let ticket = { tripId: 'trip-1', generation: 0 };
  const listeners = new Set<Parameters<TripPhotoScope['subscribeInvalidation']>[0]>();
  let cleanupTail = Promise.resolve();
  const scope: TripPhotoScope = {
    capture: () => ticket,
    isCurrent: (candidate) =>
      candidate.tripId === ticket.tripId && candidate.generation === ticket.generation,
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForCleanup: async () => cleanupTail,
  };
  return {
    scope,
    invalidate(nextTripId: string): Promise<void> {
      const previous = ticket;
      ticket = { tripId: nextTripId, generation: ticket.generation + 1 };
      const cleanups = Array.from(listeners, (listener) => {
        try {
          return Promise.resolve(listener(previous, ticket));
        } catch {
          return Promise.resolve();
        }
      });
      cleanupTail = Promise.allSettled([cleanupTail, ...cleanups]).then(() => undefined);
      return cleanupTail;
    },
  };
}

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
  activeBatch: null,
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
    scope: TEST_SCOPE,
    onUploaded: jest.fn(),
    onReconcile: jest.fn(),
    onTripNotFound: jest.fn(),
  };
}

function pickedOutcome(ownedSourceUri: string | null = null) {
  return {
    status: 'picked' as const,
    entries: [
      {
        index: 0,
        status: 'readable' as const,
        image: {
          uri: 'file:///picked/photo.heic',
          width: 4032,
          height: 3024,
          fileName: 'IMG_1.HEIC',
        },
        ownedSourceUri,
      },
    ],
  };
}

beforeEach(async () => {
  await uploadCleanupCoordinator.waitForCleanup();
  jest.clearAllMocks();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mockAuthTicket = { sessionGeneration: 1, credentialRevision: 0 };
  mockAuthCurrent = true;
  mockAuthListeners.clear();
  mockTrackPrivateRequest.mockImplementation(
    (
      _signal: AbortSignal | undefined,
      run: (signal: AbortSignal) => Promise<unknown>,
    ) => run(new AbortController().signal),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
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

it('cleans an owned picker outcome when session construction throws', async () => {
  mockPickImages.mockResolvedValueOnce(
    pickedOutcome('file:///cache/ImagePicker/owned.heic'),
  );
  mockCreateUploadSession.mockImplementationOnce(() => {
    throw new Error('constructor failed');
  });
  const { result } = await renderHook(() => usePhotoUpload(hookOptions()));

  await act(async () => {
    await result.current.pick();
  });

  expect(mockDiscardPickerSources).toHaveBeenCalledTimes(1);
  expect(mockCreateUploadSession).toHaveBeenCalledTimes(1);
  expect(result.current.snapshot).toBeNull();
  expect(result.current.pickFailure).not.toBeNull();
});

it('cleans a picker that resolves after its trip scope was invalidated', async () => {
  const scope = createScopeHarness();
  const picker = createDeferred<ReturnType<typeof pickedOutcome>>();
  mockPickImages.mockReturnValueOnce(picker.promise);
  const options = { ...hookOptions(), scope: scope.scope };
  const { result } = await renderHook(() => usePhotoUpload(options));

  let picking!: Promise<void>;
  await act(async () => {
    picking = result.current.pick();
    await Promise.resolve();
  });
  await waitFor(() => expect(mockPickImages).toHaveBeenCalledTimes(1));
  let invalidating!: Promise<void>;
  await act(async () => {
    invalidating = scope.invalidate('trip-2');
    await Promise.resolve();
  });
  picker.resolve(pickedOutcome('file:///cache/ImagePicker/stale.heic'));
  await act(async () => {
    await Promise.all([picking, invalidating]);
  });

  expect(mockCreateUploadSession).not.toHaveBeenCalled();
  expect(mockDiscardPickerSources).toHaveBeenCalledTimes(1);
  expect(result.current.snapshot).toBeNull();
});

it('cleans a pending picker on auth close and never constructs a session', async () => {
  const picker = createDeferred<ReturnType<typeof pickedOutcome>>();
  mockPickImages.mockReturnValueOnce(picker.promise);
  const { result } = await renderHook(() => usePhotoUpload(hookOptions()));

  let picking!: Promise<void>;
  await act(async () => {
    picking = result.current.pick();
    await Promise.resolve();
  });
  await waitFor(() => expect(mockPickImages).toHaveBeenCalledTimes(1));
  mockAuthCurrent = false;
  await act(async () => {
    for (const listener of Array.from(mockAuthListeners)) listener();
  });
  picker.resolve(pickedOutcome('file:///cache/ImagePicker/auth-stale.heic'));
  await act(async () => {
    await picking;
  });

  expect(mockCreateUploadSession).not.toHaveBeenCalled();
  expect(mockDiscardPickerSources).toHaveBeenCalledTimes(1);
});

it('cleans a picker outcome that resolves after unmount', async () => {
  const picker = createDeferred<ReturnType<typeof pickedOutcome>>();
  mockPickImages.mockReturnValueOnce(picker.promise);
  const { result, unmount } = await renderHook(() => usePhotoUpload(hookOptions()));

  let picking!: Promise<void>;
  await act(async () => {
    picking = result.current.pick();
    await Promise.resolve();
  });
  await waitFor(() => expect(mockPickImages).toHaveBeenCalledTimes(1));
  await unmount();
  picker.resolve(pickedOutcome('file:///cache/ImagePicker/unmounted.heic'));
  await picking;

  expect(mockCreateUploadSession).not.toHaveBeenCalled();
  expect(mockDiscardPickerSources).toHaveBeenCalledTimes(1);
});

it('retains the closing session lock until cancellation cleanup settles', async () => {
  const cancel = createDeferred<void>();
  const session = fakeSession();
  session.cancel.mockReturnValue(cancel.promise);
  mockCreateUploadSession.mockReturnValue(session);
  mockPickImages.mockResolvedValue(pickedOutcome());
  const { result } = await renderHook(() => usePhotoUpload(hookOptions()));
  await act(async () => {
    await result.current.pick();
  });

  let closing!: Promise<void>;
  await act(async () => {
    closing = result.current.close();
    await result.current.pick();
  });
  expect(mockPickImages).toHaveBeenCalledTimes(1);

  cancel.resolve();
  await act(async () => {
    await closing;
    await result.current.pick();
  });
  expect(mockPickImages).toHaveBeenCalledTimes(2);
});

it('suppresses late session callbacks after close while cleanup still completes', async () => {
  const session = fakeSession();
  mockCreateUploadSession.mockReturnValue(session);
  mockPickImages.mockResolvedValueOnce(pickedOutcome());
  const options = hookOptions();
  const { result } = await renderHook(() => usePhotoUpload(options));
  await act(async () => {
    await result.current.pick();
  });
  const deps = mockCreateUploadSession.mock.calls[0][1] as {
    onSnapshot: (snapshot: UploadSnapshot) => void;
    onUploaded: (photos: never[]) => void;
  };

  await act(async () => {
    await result.current.close();
    deps.onSnapshot({ ...SELECTED_SNAPSHOT, phase: 'complete' });
    deps.onUploaded([]);
  });

  expect(result.current.snapshot).toBeNull();
  expect(options.onUploaded).not.toHaveBeenCalled();
  expect(session.cancel).toHaveBeenCalledTimes(1);
});

it('holds Session B behind process-wide Session A auth-close cleanup', async () => {
  const cancelA = createDeferred<void>();
  const sessionA = fakeSession();
  const sessionB = fakeSession();
  sessionA.cancel.mockReturnValue(cancelA.promise);
  mockPickImages
    .mockResolvedValueOnce(pickedOutcome())
    .mockResolvedValueOnce(pickedOutcome());
  mockCreateUploadSession
    .mockReturnValueOnce(sessionA)
    .mockReturnValueOnce(sessionB);

  const optionsA = hookOptions();
  const hookA = await renderHook(() => usePhotoUpload(optionsA));
  await act(async () => {
    await hookA.result.current.pick();
  });
  const callbacksA = mockCreateUploadSession.mock.calls[0][1] as {
    onSnapshot: (snapshot: UploadSnapshot) => void;
    onUploaded: (photos: never[]) => void;
    onReconcile: () => void;
    onTripNotFound: () => void;
  };

  await act(async () => {
    mockAuthCurrent = false;
    for (const listener of Array.from(mockAuthListeners)) listener();
    await Promise.resolve();
  });
  expect(sessionA.cancel).toHaveBeenCalledTimes(1);

  mockAuthTicket = { sessionGeneration: 3, credentialRevision: 0 };
  mockAuthCurrent = true;
  const optionsB = hookOptions();
  const hookB = await renderHook(() => usePhotoUpload(optionsB));
  let pickingB!: Promise<void>;
  await act(async () => {
    pickingB = hookB.result.current.pick();
    await Promise.resolve();
  });

  expect(mockPickImages).toHaveBeenCalledTimes(1);
  expect(mockCreateUploadSession).toHaveBeenCalledTimes(1);
  expect(mockTrackPrivateRequest).not.toHaveBeenCalled();
  expect(sessionB.start).not.toHaveBeenCalled();

  await act(async () => {
    callbacksA.onSnapshot({ ...SELECTED_SNAPSHOT, phase: 'complete' });
    callbacksA.onUploaded([]);
    callbacksA.onReconcile();
    callbacksA.onTripNotFound();
  });
  expect(optionsA.onUploaded).not.toHaveBeenCalled();
  expect(optionsA.onReconcile).not.toHaveBeenCalled();
  expect(optionsA.onTripNotFound).not.toHaveBeenCalled();
  expect(hookA.result.current.snapshot).toBeNull();

  cancelA.resolve();
  await act(async () => {
    await pickingB;
  });

  expect(mockPickImages).toHaveBeenCalledTimes(2);
  expect(mockCreateUploadSession).toHaveBeenCalledTimes(2);
  expect(sessionB.start).not.toHaveBeenCalled();
  expect(mockTrackPrivateRequest).not.toHaveBeenCalled();

  await act(async () => {
    hookB.result.current.start();
    await Promise.resolve();
  });
  await waitFor(() => expect(sessionB.start).toHaveBeenCalledTimes(1));

  await hookA.unmount();
  await hookB.unmount();
  await uploadCleanupCoordinator.waitForCleanup();
});

it('holds a remounted hook behind picker source cleanup owned by the old hook', async () => {
  const pickerA = createDeferred<ReturnType<typeof pickedOutcome>>();
  const sourceCleanupA = createDeferred<undefined>();
  const sessionB = fakeSession();
  mockPickImages
    .mockReturnValueOnce(pickerA.promise)
    .mockResolvedValueOnce(pickedOutcome());
  mockDiscardPickerSources.mockReturnValueOnce(sourceCleanupA.promise);
  mockCreateUploadSession.mockReturnValueOnce(sessionB);

  const hookA = await renderHook(() => usePhotoUpload(hookOptions()));
  let pickingA!: Promise<void>;
  await act(async () => {
    pickingA = hookA.result.current.pick();
    await Promise.resolve();
  });
  await waitFor(() => expect(mockPickImages).toHaveBeenCalledTimes(1));
  await hookA.unmount();

  const hookB = await renderHook(() => usePhotoUpload(hookOptions()));
  let pickingB!: Promise<void>;
  await act(async () => {
    pickingB = hookB.result.current.pick();
    await Promise.resolve();
  });
  expect(mockPickImages).toHaveBeenCalledTimes(1);
  expect(mockCreateUploadSession).not.toHaveBeenCalled();
  expect(mockTrackPrivateRequest).not.toHaveBeenCalled();

  pickerA.resolve(pickedOutcome('file:///cache/ImagePicker/session-a.heic'));
  await waitFor(() => expect(mockDiscardPickerSources).toHaveBeenCalledTimes(1));
  expect(mockPickImages).toHaveBeenCalledTimes(1);
  expect(mockCreateUploadSession).not.toHaveBeenCalled();

  sourceCleanupA.resolve(undefined);
  await act(async () => {
    await Promise.all([pickingA, pickingB]);
  });
  expect(mockPickImages).toHaveBeenCalledTimes(2);
  expect(mockCreateUploadSession).toHaveBeenCalledTimes(1);
  expect(sessionB.start).not.toHaveBeenCalled();
  expect(mockTrackPrivateRequest).not.toHaveBeenCalled();

  await act(async () => {
    hookB.result.current.start();
    await Promise.resolve();
  });
  await waitFor(() => expect(sessionB.start).toHaveBeenCalledTimes(1));

  await hookB.unmount();
  await uploadCleanupCoordinator.waitForCleanup();
});
