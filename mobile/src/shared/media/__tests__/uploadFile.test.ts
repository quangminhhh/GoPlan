jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import type { UploadableFile } from '../types';
// eslint-disable-next-line import/first
import { buildUploadFormData, uploadFile } from '../uploadFile';

const file: UploadableFile = { uri: 'file:///out.jpg', name: 'out.jpg', type: 'image/jpeg' };

describe('buildUploadFormData', () => {
  it('carries the React Native file part under the given field name', () => {
    const form = buildUploadFormData('avatar', file);

    expect(form.getAll('avatar')).toEqual([{ uri: 'file:///out.jpg', name: 'out.jpg', type: 'image/jpeg' }]);
  });
});

describe('uploadFile', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the multipart body through apiClient and unwraps the response', async () => {
    const request = jest.spyOn(apiClient, 'request').mockResolvedValue({ data: { user: { id: 'u1' } } });

    await expect(uploadFile<{ user: { id: string } }>('/auth/avatar', 'avatar', file)).resolves.toEqual({
      user: { id: 'u1' },
    });

    const config = request.mock.calls[0][0];
    expect(config.url).toBe('/auth/avatar');
    expect(config.method).toBe('patch');
    expect((config.data as FormData).getAll('avatar')).toEqual([file]);
  });

  it('never sets Content-Type, so React Native can add the multipart boundary', async () => {
    const request = jest.spyOn(apiClient, 'request').mockResolvedValue({ data: {} });

    await uploadFile('/auth/avatar', 'avatar', file);

    expect(request.mock.calls[0][0].headers).toBeUndefined();
  });

  it('honours an explicit method', async () => {
    const request = jest.spyOn(apiClient, 'request').mockResolvedValue({ data: {} });

    await uploadFile('/trips/1/cover', 'cover_image', file, 'post');

    expect(request.mock.calls[0][0].method).toBe('post');
  });
});
