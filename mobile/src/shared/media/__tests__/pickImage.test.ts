jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

// eslint-disable-next-line import/first
import * as ImagePicker from 'expo-image-picker';
// eslint-disable-next-line import/first
import { pickImage } from '../pickImage';

const mockRequestPermission = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockLaunch = ImagePicker.launchImageLibraryAsync as jest.Mock;

describe('pickImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens the iOS system picker without requesting broad library access', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });

    await pickImage();

    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockLaunch).toHaveBeenCalledTimes(1);
  });

  it('reports cancellation as an ordinary outcome', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });

    await expect(pickImage()).resolves.toEqual({ status: 'cancelled' });
  });

  it('normalises the picked asset', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///a.heic', width: 4032, height: 3024, fileName: 'IMG_1.HEIC', mimeType: 'image/heic' }],
    });

    await expect(pickImage()).resolves.toEqual({
      status: 'picked',
      image: { uri: 'file:///a.heic', width: 4032, height: 3024, fileName: 'IMG_1.HEIC' },
    });
  });

  it('treats a canceled:false result with no asset as a cancellation', async () => {
    mockLaunch.mockResolvedValue({ canceled: false, assets: [] });

    await expect(pickImage()).resolves.toEqual({ status: 'cancelled' });
  });

  it('normalises a missing filename to null', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///a.heic', width: 10, height: 10 }],
    });

    await expect(pickImage()).resolves.toMatchObject({ image: { fileName: null } });
  });

  it('requests the OS square editor when asked', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });

    await pickImage({ square: true });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 }),
    );
  });

  it('does not request the editor by default', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });

    await pickImage();

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ allowsEditing: false, aspect: undefined }),
    );
  });
});
