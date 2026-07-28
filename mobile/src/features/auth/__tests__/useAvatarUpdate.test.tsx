const mockUpdateUser = jest.fn();
jest.mock('../session', () => ({ useSession: () => ({ updateUser: mockUpdateUser }) }));
jest.mock('@/shared/media/pickImage', () => ({ pickImage: jest.fn() }));
jest.mock('@/shared/media/preprocessImage', () => ({ preprocessImage: jest.fn() }));
jest.mock('@/shared/media/imageCodec', () => ({ nativeImageCodec: { encode: jest.fn() } }));
jest.mock('../api', () => ({ uploadAvatarRequest: jest.fn(), deleteAvatarRequest: jest.fn() }));

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { axiosError } from '@test/axiosError';
// eslint-disable-next-line import/first
import { pickImage } from '@/shared/media/pickImage';
// eslint-disable-next-line import/first
import { preprocessImage } from '@/shared/media/preprocessImage';
// eslint-disable-next-line import/first
import { ImagePreprocessError } from '@/shared/media/types';
// eslint-disable-next-line import/first
import { deleteAvatarRequest, uploadAvatarRequest } from '../api';
// eslint-disable-next-line import/first
import { useAvatarUpdate } from '../hooks/useAvatarUpdate';

const mockPick = pickImage as jest.MockedFunction<typeof pickImage>;
const mockPreprocess = preprocessImage as jest.MockedFunction<typeof preprocessImage>;
const mockUpload = uploadAvatarRequest as jest.MockedFunction<typeof uploadAvatarRequest>;
const mockDelete = deleteAvatarRequest as jest.MockedFunction<typeof deleteAvatarRequest>;

const picked = { uri: 'file:///a.heic', width: 4032, height: 4032, fileName: 'IMG_1.HEIC' };
const processed = { uri: 'file:///a.jpg', name: 'IMG_1.jpg', type: 'image/jpeg', width: 512, height: 512, bytes: 60_000 } as const;

describe('useAvatarUpdate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uploads a picked photo and replaces the session user from the response', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockResolvedValue({ id: 'u1', avatar_url: '/media/a.webp' } as never);

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });

    expect(mockPick).toHaveBeenCalledWith({ square: true });
    expect(mockPreprocess).toHaveBeenCalledWith(picked, { maxEdgePx: 512, maxBytes: 512_000 }, expect.anything());
    expect(mockUpload).toHaveBeenCalledWith(processed);
    expect(mockUpdateUser).toHaveBeenCalledWith({ id: 'u1', avatar_url: '/media/a.webp' });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.error).toBeNull();
  });

  it('treats cancellation as a no-op with no error', async () => {
    mockPick.mockResolvedValue({ status: 'cancelled' });

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('reports a preprocess failure without contacting the server', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockRejectedValue(new ImagePreprocessError('BUDGET_UNREACHABLE', 'internal'));

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });

    expect(mockUpload).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Could not prepare that photo. Try another one.');
    expect(result.current.status).toBe('idle');
  });

  it.each([
    ['AVATAR_TOO_LARGE', 'Avatar file exceeds 500KB limit.'],
    ['AVATAR_INVALID_FORMAT', 'Unsupported image format.'],
    ['AVATAR_STORAGE_SAVE_FAILED', 'Could not update avatar storage safely. Please try again.'],
  ])('surfaces the server message for %s and leaves the spinner off', async (errorCode, detail) => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockRejectedValue(axiosError(400, { detail, error_code: errorCode }));

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });

    expect(result.current.error).toBe(detail);
    expect(result.current.status).toBe('idle');
  });

  it('surfaces a throttled avatar upload as its own state', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockRejectedValue(axiosError(429, {}));

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });

    expect(result.current.error).toBe('Too many attempts. Please wait a moment and try again.');
  });

  it('removes the avatar and replaces the session user', async () => {
    mockDelete.mockResolvedValue({ id: 'u1', avatar_url: null } as never);

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.removeAvatar(); });

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith({ id: 'u1', avatar_url: null });
    expect(result.current.status).toBe('idle');
  });

  it('ignores a second tap that lands before the first upload finishes', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockResolvedValue({ id: 'u1', avatar_url: '/media/a.webp' } as never);

    const { result } = await renderHook(useAvatarUpdate);
    // Both taps are dispatched before React can re-render and disable the
    // button, which is exactly what a fast double tap produces on device.
    await act(async () => {
      await Promise.all([result.current.changeAvatar(), result.current.changeAvatar()]);
    });

    expect(mockPick).toHaveBeenCalledTimes(1);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('ignores a remove tap that lands while an upload is running', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockResolvedValue({ id: 'u1', avatar_url: '/media/a.webp' } as never);

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => {
      await Promise.all([result.current.changeAvatar(), result.current.removeAvatar()]);
    });

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('releases the lock so a later change still runs', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockResolvedValue(processed);
    mockUpload.mockResolvedValue({ id: 'u1', avatar_url: '/media/a.webp' } as never);

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });
    await act(async () => { await result.current.changeAvatar(); });

    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('dismissError clears a previous failure', async () => {
    mockPick.mockResolvedValue({ status: 'picked', image: picked });
    mockPreprocess.mockRejectedValue(new ImagePreprocessError('UNREADABLE', 'internal'));

    const { result } = await renderHook(useAvatarUpdate);
    await act(async () => { await result.current.changeAvatar(); });
    expect(result.current.error).not.toBeNull();

    await act(async () => { result.current.dismissError(); });
    expect(result.current.error).toBeNull();
  });
});
