jest.mock('../protectedAssetStore', () => ({
  purgeProtectedAssets: jest.fn(async () => undefined),
}));

jest.mock('../uploadTempStore', () => ({
  purgeUploadTempFiles: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import {
  __clearPrivateMediaPurgersForTests,
  __getPrivateMediaPurgerNamesForTests,
  __resetPrivateMediaLifecycleForTests,
  startPrivateMediaSession,
} from '../privateMediaLifecycle';
// eslint-disable-next-line import/first
import {
  __resetPrivateMediaPurgersForTests,
  registerDefaultPrivateMediaPurgers,
} from '../privateMediaPurgers';
// eslint-disable-next-line import/first
import { purgeProtectedAssets } from '../protectedAssetStore';
// eslint-disable-next-line import/first
import { purgeUploadTempFiles } from '../uploadTempStore';

beforeEach(() => {
  jest.clearAllMocks();
  __resetPrivateMediaLifecycleForTests();
  __clearPrivateMediaPurgersForTests();
  __resetPrivateMediaPurgersForTests();
});

it('registers and runs both namespace purgers before a cold session opens', async () => {
  registerDefaultPrivateMediaPurgers();

  expect(__getPrivateMediaPurgerNamesForTests().sort()).toEqual([
    'protected-assets',
    'upload-temp',
  ]);

  await startPrivateMediaSession();

  expect(purgeProtectedAssets).toHaveBeenCalledTimes(1);
  expect(purgeUploadTempFiles).toHaveBeenCalledTimes(1);
});
