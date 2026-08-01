jest.mock('@/shared/media/pickImage', () => ({ pickImage: jest.fn() }));
jest.mock('@/shared/media/preprocessImage', () => ({ preprocessImage: jest.fn() }));
jest.mock('@/shared/media/imageCodec', () => ({
  nativeImageCodec: { encode: jest.fn(), discard: jest.fn(async () => undefined) },
}));
const mockDiscardPickerSource = jest.fn(async (_uri: string) => undefined);
jest.mock('@/shared/media/pickerSourceStore', () => ({
  claimAppOwnedPickerSourceUri: jest.fn((uri: string) => uri),
  discardAppOwnedPickerSource: (uri: string) => mockDiscardPickerSource(uri),
}));
jest.mock('../api', () => ({ uploadTripCover: jest.fn() }));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { axiosError } from '@test/axiosError';
// eslint-disable-next-line import/first
import { nativeImageCodec } from '@/shared/media/imageCodec';
// eslint-disable-next-line import/first
import { pickImage } from '@/shared/media/pickImage';
// eslint-disable-next-line import/first
import { claimAppOwnedPickerSourceUri } from '@/shared/media/pickerSourceStore';
// eslint-disable-next-line import/first
import { preprocessImage } from '@/shared/media/preprocessImage';
// eslint-disable-next-line import/first
import { ImagePreprocessError } from '@/shared/media/types';
// eslint-disable-next-line import/first
import { uploadTripCover } from '../api';
// eslint-disable-next-line import/first
import { useTripCoverUpload } from '../hooks/useTripCoverUpload';

const mockPick = pickImage as jest.MockedFunction<typeof pickImage>;
const mockPreprocess = preprocessImage as jest.MockedFunction<typeof preprocessImage>;
const mockUpload = uploadTripCover as jest.MockedFunction<typeof uploadTripCover>;

const picked = { uri: 'file:///cover.heic', width: 4032, height: 3024, fileName: 'IMG_9.HEIC' };
const ownedSourceUri = claimAppOwnedPickerSourceUri(picked.uri);
if (!ownedSourceUri) throw new Error('Expected an owned picker test URI.');
const processed = {
  uri: 'file:///cover.jpg',
  name: 'IMG_9.jpg',
  type: 'image/jpeg',
  width: 2560,
  height: 1920,
  bytes: 1_200_000,
} as const;
const UPLOADED_URL = '/media/trip-covers/8f0e.webp';

function pickAndUploadSucceed(): void {
  mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
  mockPreprocess.mockResolvedValue(processed);
  mockUpload.mockResolvedValue(UPLOADED_URL);
}

describe('useTripCoverUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so restore the default rather than
    // letting one test's rejecting discard leak into the next.
    (nativeImageCodec.discard as jest.Mock).mockResolvedValue(undefined);
    mockDiscardPickerSource.mockResolvedValue(undefined);
  });

  it('starts from the trip cover it was given', async () => {
    const { result } = await renderHook(() => useTripCoverUpload('/media/trip-covers/a.webp'));

    expect(result.current.coverUrl).toBe('/media/trip-covers/a.webp');
    expect(result.current.changed).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it('holds the server-returned url after a successful upload', async () => {
    pickAndUploadSucceed();

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });

    expect(mockPick).toHaveBeenCalledWith({ square: false });
    expect(mockPreprocess).toHaveBeenCalledWith(
      picked,
      { maxEdgePx: 2560, maxBytes: 10_485_760 },
      expect.anything(),
    );
    expect(mockUpload).toHaveBeenCalledWith(processed);
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.coverUrl).toBe(UPLOADED_URL);
    expect(result.current.changed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('treats cancellation as a no-op', async () => {
    mockPick.mockResolvedValue({ status: 'cancelled' });

    const { result } = await renderHook(() => useTripCoverUpload('/media/trip-covers/a.webp'));
    await act(async () => { await result.current.chooseCover(); });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.coverUrl).toBe('/media/trip-covers/a.webp');
    expect(result.current.changed).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('reports a preprocess failure in our own words without contacting the server', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
    mockPreprocess.mockRejectedValue(new ImagePreprocessError('BUDGET_UNREACHABLE', 'internal'));

    const { result } = await renderHook(() => useTripCoverUpload('/media/trip-covers/a.webp'));
    await act(async () => { await result.current.chooseCover(); });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Could not prepare that photo. Try another one.');
    expect(result.current.coverUrl).toBe('/media/trip-covers/a.webp');
    expect(result.current.status).toBe('idle');
  });

  it.each([
    ['NO_FILE', 'No file was uploaded.'],
    ['UNSUPPORTED_IMAGE_FORMAT', 'Unsupported image format.'],
  ])('surfaces the server message for %s exactly as returned', async (errorCode, detail) => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockRejectedValue(axiosError(400, { detail, error_code: errorCode }));

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });

    expect(result.current.error).toBe(detail);
    expect(result.current.coverUrl).toBe('');
    expect(result.current.status).toBe('idle');
  });

  it('surfaces an exhausted media_upload budget as the throttle message', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockRejectedValue(axiosError(429, {}));

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });

    expect(result.current.error).toBe('Too many attempts. Please wait a moment and try again.');
  });

  it('clears the previous error when a retry succeeds', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockRejectedValueOnce(axiosError(429, {})).mockResolvedValueOnce(UPLOADED_URL);

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });
    expect(result.current.error).not.toBeNull();

    await act(async () => { await result.current.chooseCover(); });

    expect(result.current.error).toBeNull();
    expect(result.current.coverUrl).toBe(UPLOADED_URL);
  });

  it('ignores a second tap that lands before the first upload finishes', async () => {
    pickAndUploadSucceed();

    const { result } = await renderHook(() => useTripCoverUpload());
    // Both taps are dispatched before React can re-render and disable the
    // button, which is exactly what a fast double tap produces on device.
    await act(async () => {
      await Promise.all([result.current.chooseCover(), result.current.chooseCover()]);
    });

    expect(mockPick).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('removes the cover locally without calling any delete endpoint', async () => {
    pickAndUploadSucceed();

    const { result } = await renderHook(() => useTripCoverUpload('/media/trip-covers/a.webp'));
    await act(async () => { result.current.removeCover(); });

    expect(result.current.coverUrl).toBe('');
    expect(result.current.changed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('discards the capability-owned source and encoded temp once upload is done', async () => {
    pickAndUploadSucceed();

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });

    expect(mockDiscardPickerSource).toHaveBeenCalledWith(ownedSourceUri);
    expect(nativeImageCodec.discard).not.toHaveBeenCalledWith(picked.uri);
    expect(nativeImageCodec.discard).toHaveBeenCalledWith(processed.uri);
  });

  it('discards the picked source on the failure path too', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockRejectedValue(axiosError(400, { detail: 'Unsupported image format.' }));

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });

    expect(mockDiscardPickerSource).toHaveBeenCalledWith(ownedSourceUri);
    expect(nativeImageCodec.discard).not.toHaveBeenCalledWith(picked.uri);
    expect(nativeImageCodec.discard).toHaveBeenCalledWith(processed.uri);
    expect(result.current.error).not.toBeNull();
  });

  it('still reports success when discarding a temp file fails', async () => {
    pickAndUploadSucceed();
    (nativeImageCodec.discard as jest.Mock).mockRejectedValue(new Error('delete failed'));

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });

    expect(result.current.coverUrl).toBe(UPLOADED_URL);
    expect(result.current.error).toBeNull();
  });

  it('dismissError clears a previous failure', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked, ownedSourceUri });
    mockPreprocess.mockRejectedValue(new ImagePreprocessError('UNREADABLE', 'internal'));

    const { result } = await renderHook(() => useTripCoverUpload());
    await act(async () => { await result.current.chooseCover(); });
    expect(result.current.error).not.toBeNull();

    await act(async () => { result.current.dismissError(); });
    expect(result.current.error).toBeNull();
  });
});
