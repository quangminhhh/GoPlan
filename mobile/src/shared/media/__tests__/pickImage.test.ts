jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const mockClaimPickerSource = jest.fn((uri: string) =>
  uri.startsWith('file:///cache/ImagePicker/') ? uri : null,
);

jest.mock('../pickerSourceStore', () => ({
  claimAppOwnedPickerSourceUri: (uri: string) => mockClaimPickerSource(uri),
}));

// eslint-disable-next-line import/first
import * as ImagePicker from 'expo-image-picker';
// eslint-disable-next-line import/first
import { hasUsableDimensions, pickImage, pickImages } from '../pickImage';

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
      ownedSourceUri: null,
      image: { uri: 'file:///a.heic', width: 4032, height: 3024, fileName: 'IMG_1.HEIC' },
    });
  });

  it('keeps delete authority separate from the image read URI', async () => {
    const uri = 'file:///cache/ImagePicker/owned.heic';
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri, width: 100, height: 100, fileName: null }],
    });

    await expect(pickImage()).resolves.toMatchObject({
      image: { uri },
      ownedSourceUri: uri,
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

describe('pickImages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens a multi-select picker with an explicit unlimited selection and guaranteed order', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });

    await pickImages();

    expect(mockRequestPermission).not.toHaveBeenCalled();
    const options = mockLaunch.mock.calls[0][0];
    expect(options).toMatchObject({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      // iOS ignores the editor with multi-select on, and cropping a batch is not
      // something this flow offers.
      allowsEditing: false,
      // 0 is the system maximum. Set explicitly so a 60-photo selection can
      // never be silently truncated by a future default change.
      selectionLimit: 0,
      // Without this, the docs only say assets "should" come back in selection
      // order — which is not enough to number an upload ledger against.
      orderedSelection: true,
      // An iCloud-only photo has to be materialised before it can be read.
      shouldDownloadFromNetwork: true,
      quality: 1,
      exif: false,
    });
  });

  it('returns every asset in picker order', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///c.heic', width: 4032, height: 3024, fileName: 'c.HEIC' },
        { uri: 'file:///a.heic', width: 3024, height: 4032, fileName: 'a.HEIC' },
      ],
    });

    const outcome = await pickImages();

    expect(outcome.status).toBe('picked');
    if (outcome.status !== 'picked') return;
    expect(
      outcome.entries.map((entry) =>
        entry.status === 'readable' ? entry.image.uri : entry.fileName,
      ),
    ).toEqual(['file:///c.heic', 'file:///a.heic']);
  });

  it('rejects only the assets with unusable dimensions, keeping the rest', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///ok.heic', width: 4032, height: 3024, fileName: 'ok.HEIC' },
        // Documented as possible: calling a native resize with 0 crashes rather
        // than failing the file.
        { uri: 'file:///broken.heic', width: 0, height: 0, fileName: 'broken.HEIC' },
        { uri: 'file:///ok2.heic', width: 100, height: 100, fileName: null },
      ],
    });

    const outcome = await pickImages();

    expect(outcome.status).toBe('picked');
    if (outcome.status !== 'picked') return;
    expect(outcome.entries).toEqual([
      {
        index: 0,
        status: 'readable',
        image: {
          uri: 'file:///ok.heic',
          width: 4032,
          height: 3024,
          fileName: 'ok.HEIC',
        },
        ownedSourceUri: null,
      },
      {
        index: 1,
        status: 'unreadable',
        fileName: 'broken.HEIC',
        ownedSourceUri: null,
      },
      {
        index: 2,
        status: 'readable',
        image: {
          uri: 'file:///ok2.heic',
          width: 100,
          height: 100,
          fileName: null,
        },
        ownedSourceUri: null,
      },
    ]);
  });

  it('preserves cleanup authority for an unreadable picker asset', async () => {
    const uri = 'file:///cache/ImagePicker/unreadable.heic';
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [{ uri, width: 0, height: 0, fileName: 'cloud.heic' }],
    });

    const outcome = await pickImages();

    expect(outcome).toEqual({
      status: 'picked',
      entries: [
        {
          index: 0,
          status: 'unreadable',
          fileName: 'cloud.heic',
          ownedSourceUri: uri,
        },
      ],
    });
  });

  it('reports cancellation as an ordinary outcome', async () => {
    mockLaunch.mockResolvedValue({ canceled: true, assets: null });

    await expect(pickImages()).resolves.toEqual({ status: 'cancelled' });
  });

  it('treats an empty asset list as a cancellation', async () => {
    mockLaunch.mockResolvedValue({ canceled: false, assets: [] });

    await expect(pickImages()).resolves.toEqual({ status: 'cancelled' });
  });
});

describe('hasUsableDimensions', () => {
  it.each([
    [{ width: 0, height: 100 }, false],
    [{ width: 100, height: 0 }, false],
    [{ width: -1, height: 100 }, false],
    [{ width: Number.NaN, height: 100 }, false],
    [{ width: Number.POSITIVE_INFINITY, height: 100 }, false],
    [{ width: 10.5, height: 100 }, false],
    [{ width: 1, height: 1 }, true],
    [{ width: 4032, height: 3024 }, true],
  ])('%j -> %s', (asset, expected) => {
    expect(hasUsableDimensions(asset)).toBe(expected);
  });
});
