/**
 * Registers the two owned private-media namespaces before auth restoration.
 *
 * Photo routes are lazy-loaded by Expo Router, so relying only on module-scope
 * registration in their storage modules leaves a cold-start window where the
 * lifecycle registry is empty. Importing this bootstrap from the auth root
 * evaluates both namespace owners before the first cleanup can begin.
 */

import { registerPrivateMediaPurger } from './privateMediaLifecycle';
import { purgeProtectedAssets } from './protectedAssetStore';
import { purgeUploadTempFiles } from './uploadTempStore';

let registered = false;

export function registerDefaultPrivateMediaPurgers(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerPrivateMediaPurger('protected-assets', purgeProtectedAssets);
  registerPrivateMediaPurger('upload-temp', purgeUploadTempFiles);
}

export function __resetPrivateMediaPurgersForTests(): void {
  registered = false;
}
