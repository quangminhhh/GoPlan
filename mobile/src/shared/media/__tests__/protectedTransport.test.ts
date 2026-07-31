const mockExistingUris = new Set<string>();
const mockDeletedUris = jest.fn<void, [string]>();

jest.mock('expo/fetch', () => ({
  fetch: jest.fn(),
}));

jest.mock('expo-file-system', () => {
  class MockDirectory {
    readonly uri: string;
    exists = true;

    constructor(parent: string, name: string) {
      this.uri = `${parent.replace(/\/$/, '')}/${name}`;
    }

    create(): void {}

    delete(): void {}
  }

  class MockFile {
    readonly uri: string;

    constructor(parent: string | MockDirectory, name?: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.uri = name ? `${base.replace(/\/$/, '')}/${name}` : base;
    }

    get exists(): boolean {
      return mockExistingUris.has(this.uri);
    }

    create(): void {
      mockExistingUris.add(this.uri);
    }

    delete(): void {
      mockDeletedUris(this.uri);
      mockExistingUris.delete(this.uri);
    }

    writableStream(): never {
      throw new Error('writer creation failed');
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: {
      cache: 'file:///cache',
      availableDiskSpace: 8 * 1024 * 1024 * 1024,
    },
  };
});

// Keep this below the stateful native-module fakes: their factory closes over
// the sets above, and the production module constructs its default stores while
// it is imported.
// eslint-disable-next-line import/first
import { createNativeFileStore } from '../protectedTransport';

describe('createNativeFileStore', () => {
  beforeEach(() => {
    mockExistingUris.clear();
    mockDeletedUris.mockClear();
  });

  it('removes a file created before NativeFileSink construction rejects', async () => {
    const store = createNativeFileStore('atomic-sink-test');

    await expect(store.createSink('asset.webp')).rejects.toThrow('writer creation failed');

    expect(mockExistingUris.size).toBe(0);
    expect(mockDeletedUris).toHaveBeenCalledWith(
      'file:///cache/atomic-sink-test/asset.webp',
    );
  });
});
