import {
  __getAdoptedUploadTempUrisForTests,
  __resetUploadTempStoreForTests,
  adoptUploadTempFile,
  discardUploadTempFile,
  purgeUploadTempFiles,
  uploadTempAvailableBytes,
  UploadTempStorageError,
} from '../uploadTempStore';
import { UPLOAD_TEMP_NAMESPACE } from '../protectedTransport';
import { createFakeFileStore } from '@test/fakeProtectedTransport';

function fakeMove(moved: { from: string; to: string }[]) {
  return async (fromUri: string, namespace: string, fileName: string): Promise<string> => {
    const to = `file:///cache/${namespace}/${fileName}`;
    moved.push({ from: fromUri, to });
    return to;
  };
}

beforeEach(() => {
  __resetUploadTempStoreForTests();
});

describe('adoptUploadTempFile', () => {
  it('moves an encoder output into the stable upload namespace under an opaque name', async () => {
    const moved: { from: string; to: string }[] = [];
    const store = createFakeFileStore();

    const adopted = await adoptUploadTempFile({
      uri: 'file:///ImageManipulator/original-name.jpg',
      bytes: 2048,
      mimeType: 'image/jpeg',
      store,
      move: fakeMove(moved),
    });

    expect(moved[0].from).toBe('file:///ImageManipulator/original-name.jpg');
    expect(adopted.uri).toContain(UPLOAD_TEMP_NAMESPACE);
    expect(adopted.uri.endsWith('.jpg')).toBe(true);
    // The picker's own name must not become the temp file name.
    expect(adopted.uri).not.toContain('original-name');
    expect(adopted.bytes).toBe(2048);
    expect(__getAdoptedUploadTempUrisForTests()).toEqual([adopted.uri]);
  });

  it('derives the extension from the reported mime type, not from the source path', async () => {
    const store = createFakeFileStore();
    const adopted = await adoptUploadTempFile({
      uri: 'file:///tmp/misleading.jpg',
      bytes: 1,
      mimeType: 'image/webp',
      store,
      move: fakeMove([]),
    });

    expect(adopted.uri.endsWith('.webp')).toBe(true);
  });

  it('surfaces a failed move as a storage error the caller can reject one file on', async () => {
    const store = createFakeFileStore();

    await expect(
      adoptUploadTempFile({
        uri: 'file:///tmp/a.jpg',
        bytes: 1,
        mimeType: 'image/jpeg',
        store,
        move: async () => {
          throw new Error('no space left on device');
        },
      }),
    ).rejects.toBeInstanceOf(UploadTempStorageError);

    expect(__getAdoptedUploadTempUrisForTests()).toEqual([]);
  });
});

describe('cleanup', () => {
  it('discards one adopted file', async () => {
    const store = createFakeFileStore();
    const adopted = await adoptUploadTempFile({
      uri: 'file:///tmp/a.jpg',
      bytes: 1,
      mimeType: 'image/jpeg',
      store,
      move: fakeMove([]),
    });

    await discardUploadTempFile(adopted.uri, store);

    expect(__getAdoptedUploadTempUrisForTests()).toEqual([]);
    expect(store.discarded()).toContain(adopted.uri);
  });

  it('purges the whole namespace, including files a previous process left behind', async () => {
    const store = createFakeFileStore();
    await adoptUploadTempFile({
      uri: 'file:///tmp/a.jpg',
      bytes: 1,
      mimeType: 'image/jpeg',
      store,
      move: fakeMove([]),
    });

    await purgeUploadTempFiles();

    expect(__getAdoptedUploadTempUrisForTests()).toEqual([]);
    expect(store.purgeCount()).toBe(1);
  });
});

describe('free space', () => {
  it('reports what the store says, including that it cannot say', () => {
    const store = createFakeFileStore();

    store.setAvailableBytes(1234);
    expect(uploadTempAvailableBytes(store)).toBe(1234);

    store.setAvailableBytes(null);
    expect(uploadTempAvailableBytes(store)).toBeNull();
  });
});
