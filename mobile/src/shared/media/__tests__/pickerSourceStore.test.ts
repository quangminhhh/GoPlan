const mockDeleted = jest.fn<void, [string]>();
const mockExisting = new Set<string>();

jest.mock('expo-file-system', () => {
  class MockDirectory {
    readonly uri: string;

    constructor(parent: string | { uri: string }, name: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.uri = `${base.replace(/\/$/, '')}/${name}`;
    }
  }

  class MockFile {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return mockExisting.has(this.uri);
    }

    delete(): void {
      mockDeleted(this.uri);
      mockExisting.delete(this.uri);
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { cache: { uri: 'file:///app/Library/Caches' } },
  };
});

// eslint-disable-next-line import/first
import {
  claimAppOwnedPickerSourceUri,
  discardAppOwnedPickerSource,
  discardAppOwnedPickerSources,
} from '../pickerSourceStore';

describe('pickerSourceStore', () => {
  beforeEach(() => {
    mockDeleted.mockClear();
    mockExisting.clear();
  });

  it.each([
    'ph://asset-id',
    'assets-library://asset/asset.JPG?id=1',
    'https://example.com/photo.jpg',
    'file:///app/Library/Caches/another/photo.jpg',
    'file:///app/Library/Caches/ImagePicker/../photo.jpg',
    'file:///app/Library/Caches/ImagePicker',
  ])('does not grant delete authority to %s', (uri) => {
    expect(claimAppOwnedPickerSourceUri(uri)).toBeNull();
  });

  it('grants authority only below the fixed ImagePicker directory', () => {
    expect(
      claimAppOwnedPickerSourceUri(
        'file:///app/Library/Caches/ImagePicker/selection/IMG%2001.HEIC',
      ),
    ).toBe('file:///app/Library/Caches/ImagePicker/selection/IMG%2001.HEIC');
  });

  it('deletes only through a validated capability and is best effort', async () => {
    const uri = 'file:///app/Library/Caches/ImagePicker/owned.heic';
    const owned = claimAppOwnedPickerSourceUri(uri);
    expect(owned).not.toBeNull();
    if (!owned) return;
    mockExisting.add(uri);

    await discardAppOwnedPickerSource(owned);
    await discardAppOwnedPickerSource(owned);

    expect(mockDeleted).toHaveBeenCalledTimes(1);
    expect(mockDeleted).toHaveBeenCalledWith(uri);
  });

  it('deduplicates an abandoned outcome and absorbs cleanup rejection', async () => {
    const uri = 'file:///app/Library/Caches/ImagePicker/owned.heic';
    const owned = claimAppOwnedPickerSourceUri(uri);
    expect(owned).not.toBeNull();
    if (!owned) return;
    const discard = jest.fn(async () => {
      throw new Error('busy');
    });

    await expect(
      discardAppOwnedPickerSources([owned, null, owned], discard),
    ).resolves.toBeUndefined();
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
