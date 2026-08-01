import {
  createPhotoSaveTempCoordinator,
  PhotoSaveTempStoreError,
} from '../photoSaveTempStore';
import {
  __clearPrivateMediaPurgersForTests,
  __resetPrivateMediaLifecycleForTests,
  acquirePrivateTransferLease,
  flushPrivateMediaPurge,
  registerPrivateMediaPurger,
  startPrivateMediaSession,
  suspendPrivateMediaSession,
} from '../privateMediaLifecycle';
import { PHOTO_SAVE_TEMP_NAMESPACE } from '../protectedTransport';
import {
  createDeferred,
  createFakeFileStore,
  flushMicrotasks,
} from '@test/fakeProtectedTransport';

describe('photoSaveTempCoordinator', () => {
  beforeEach(() => {
    __resetPrivateMediaLifecycleForTests();
  });

  it('purges a crash-left orphan from goplan-photo-save during idempotent startup', async () => {
    const store = createFakeFileStore(PHOTO_SAVE_TEMP_NAMESPACE);
    const orphan = await store.createSink('m7y2f-1-q4w8e2.jpg');
    await orphan.write(new Uint8Array([1]));
    await orphan.close();
    const coordinator = createPhotoSaveTempCoordinator(store);

    expect(orphan.uri).toContain(`/${PHOTO_SAVE_TEMP_NAMESPACE}/`);
    expect(store.contents().has(orphan.uri)).toBe(true);

    const first = coordinator.bootstrap();
    const second = coordinator.bootstrap();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(store.contents().size).toBe(0);
    expect(store.purgeCount()).toBe(1);
  });

  it('allows only one live run and never queues a rapid second action', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(4, true);
    const run = await coordinator.beginRun(ticket);

    await expect(coordinator.beginRun(ticket)).rejects.toMatchObject({ kind: 'busy' });
    run.release();

    const next = await coordinator.beginRun(ticket);
    expect(next.signal.aborted).toBe(false);
    next.release();
  });

  it('allows only one current file and keeps its opaque namespace identity', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(7, true);
    const run = await coordinator.beginRun(ticket);
    const current = await coordinator.createCurrent('.webp', ticket);

    expect(current.uri).toContain('/goplan-photo-save-test/');
    expect(current.uri).toMatch(/\.webp$/);
    expect(current.uri).not.toContain('trip');
    expect(store.createdFileNames()).toHaveLength(1);
    expect(store.createdFileNames()[0]).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+\.webp$/);
    await expect(coordinator.createCurrent('.jpg', ticket)).rejects.toMatchObject({ kind: 'busy' });

    await current.discard();
    run.release();
  });

  it('aborts and discards immediately when closed before native commit', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(1, true);
    const run = await coordinator.beginRun(ticket);
    const current = await coordinator.createCurrent('.webp', ticket);
    await current.sink.write(new Uint8Array([1, 2, 3]));

    coordinator.suspend('signOut');
    await flushMicrotasks();

    expect(run.signal.aborted).toBe(true);
    expect(store.contents().has(current.uri)).toBe(false);
    expect(coordinator.captureTicket()).toBeNull();
    run.release();
  });

  it('holds the exact file through a native commit and deletes it only after settle', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(1, true);
    const run = await coordinator.beginRun(ticket);
    const current = await coordinator.createCurrent('.webp', ticket);
    await current.sink.write(new Uint8Array([1, 2, 3]));
    await current.sink.close();
    const fence = coordinator.beginCommit(current.uri, ticket);

    coordinator.suspend('background');
    await flushMicrotasks();
    expect(run.signal.aborted).toBe(true);
    expect(store.contents().has(current.uri)).toBe(true);

    await fence.settleAndDiscard();
    expect(store.contents().has(current.uri)).toBe(false);
    run.release();
  });

  it('does not let Session B begin until Session A releases and its fence cleans up', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticketA = coordinator.activateSession(1, true);
    const runA = await coordinator.beginRun(ticketA);
    const currentA = await coordinator.createCurrent('.webp', ticketA);
    const fenceA = coordinator.beginCommit(currentA.uri, ticketA);

    coordinator.suspend('signOut');
    const ticketB = coordinator.activateSession(2, true);
    runA.release();
    let bStarted = false;
    const pendingB = coordinator.beginRun(ticketB).then((run) => {
      bStarted = true;
      return run;
    });
    await flushMicrotasks();
    expect(bStarted).toBe(false);

    await fenceA.settleAndDiscard();
    const runB = await pendingB;
    expect(bStarted).toBe(true);
    const currentB = await coordinator.createCurrent('.jpg', ticketB);
    expect(currentB.uri).not.toBe(currentA.uri);
    await currentB.discard();
    runB.release();
  });

  it('discards a sink that resolves after its generation closes', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const originalCreateSink = store.createSink.bind(store);
    const sinkStarted = createDeferred<void>();
    const allowSink = createDeferred<void>();
    store.createSink = async (fileName: string) => {
      sinkStarted.resolve();
      await allowSink.promise;
      return originalCreateSink(fileName);
    };
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticketA = coordinator.activateSession(1, true);
    const runA = await coordinator.beginRun(ticketA);
    const pendingCreate = coordinator.createCurrent('.webp', ticketA);
    await sinkStarted.promise;

    coordinator.suspend('signOut');
    runA.release();
    const ticketB = coordinator.activateSession(2, true);
    let bStarted = false;
    const pendingB = coordinator.beginRun(ticketB).then((run) => {
      bStarted = true;
      return run;
    });

    allowSink.resolve();
    await expect(pendingCreate).rejects.toMatchObject({ kind: 'cancelled' });
    const runB = await pendingB;
    expect(bStarted).toBe(true);
    expect(store.contents().size).toBe(0);
    runB.release();
  });

  it('keeps repeated suspend idempotent and resumes with a fresh ticket', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticketA = coordinator.activateSession(10, true);
    const runA = await coordinator.beginRun(ticketA);

    coordinator.suspend('background');
    coordinator.suspend('background');
    expect(runA.signal.aborted).toBe(true);
    runA.release();

    const ticketB = coordinator.resume(10);
    expect(ticketB.storeGeneration).toBeGreaterThan(ticketA.storeGeneration);
    expect(coordinator.captureTicket()).toEqual(ticketB);
    const runB = await coordinator.beginRun(ticketB);
    runB.release();
  });

  it('aborts independently from an unrelated generic transfer lease', async () => {
    await startPrivateMediaSession();
    const releaseGenericLease = acquirePrivateTransferLease();
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(1, true);
    const run = await coordinator.beginRun(ticket);

    coordinator.suspend('background');

    expect(run.signal.aborted).toBe(true);
    releaseGenericLease();
    run.release();
  });

  it('does not block general cache/upload purges while a native fence is pending', async () => {
    __clearPrivateMediaPurgersForTests();
    const purgeAssets = jest.fn(async () => undefined);
    const purgeUploads = jest.fn(async () => undefined);
    registerPrivateMediaPurger('protected-assets', purgeAssets);
    registerPrivateMediaPurger('upload-temp', purgeUploads);
    await startPrivateMediaSession();
    purgeAssets.mockClear();
    purgeUploads.mockClear();

    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(1, true);
    const run = await coordinator.beginRun(ticket);
    const current = await coordinator.createCurrent('.webp', ticket);
    const fence = coordinator.beginCommit(current.uri, ticket);

    suspendPrivateMediaSession();
    await flushPrivateMediaPurge();

    expect(purgeAssets).toHaveBeenCalledTimes(1);
    expect(purgeUploads).toHaveBeenCalledTimes(1);
    expect(store.contents().has(current.uri)).toBe(true);

    await fence.settleAndDiscard();
    run.release();
  });

  it('rejects commit handoff unless the URI is the exact current file', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(1, true);
    const run = await coordinator.beginRun(ticket);
    const current = await coordinator.createCurrent('.webp', ticket);

    expect(() => coordinator.beginCommit('file:///other/photo.webp', ticket)).toThrow(
      PhotoSaveTempStoreError,
    );

    await current.discard();
    run.release();
  });

  it('reports free space and stats only the exact current file', async () => {
    const store = createFakeFileStore('goplan-photo-save-test');
    store.setAvailableBytes(1234);
    const coordinator = createPhotoSaveTempCoordinator(store);
    const ticket = coordinator.activateSession(1, true);
    const run = await coordinator.beginRun(ticket);
    const current = await coordinator.createCurrent('.webp', ticket);
    await current.sink.write(new Uint8Array([1, 2, 3, 4]));

    expect(coordinator.availableBytes()).toBe(1234);
    await expect(coordinator.stat(current.uri)).resolves.toEqual({ bytes: 4 });
    await expect(coordinator.stat('file:///other')).resolves.toBeNull();

    await current.discard();
    run.release();
  });
});
