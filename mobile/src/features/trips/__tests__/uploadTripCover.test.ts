jest.mock('@/shared/media/uploadFile', () => ({ uploadFile: jest.fn() }));

// eslint-disable-next-line import/first
import type { UploadableFile } from '@/shared/media/types';
// eslint-disable-next-line import/first
import { uploadFile } from '@/shared/media/uploadFile';
// eslint-disable-next-line import/first
import { TRIP_COVER_UPLOAD_TIMEOUT_MS, uploadTripCover } from '../api';

// Lives apart from api.test.ts: that file mocks the axios client itself, while a
// cover goes out through the shared multipart helper.
const mockUploadFile = uploadFile as jest.MockedFunction<typeof uploadFile>;

const file: UploadableFile = { uri: 'file:///cover.jpg', name: 'cover.jpg', type: 'image/jpeg' };

describe('uploadTripCover', () => {
  beforeEach(() => mockUploadFile.mockReset());

  it('posts the cover with a timeout long enough for a 10 MB body', async () => {
    mockUploadFile.mockResolvedValue({ url: '/media/trip-covers/abc.webp' });

    await expect(uploadTripCover(file)).resolves.toBe('/media/trip-covers/abc.webp');

    expect(mockUploadFile).toHaveBeenCalledWith('/media/trip-covers', 'file', file, 'post', {
      timeoutMs: TRIP_COVER_UPLOAD_TIMEOUT_MS,
    });
  });

  it('keeps a cover timeout well above the 15s client default', () => {
    expect(TRIP_COVER_UPLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
