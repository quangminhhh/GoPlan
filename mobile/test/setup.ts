process.env.EXPO_PUBLIC_API_URL = 'http://testserver:8000';

// The jest environment's built-in FormData stringifies non-Blob values, so a
// React Native `{uri, name, type}` file part would silently become
// "[object Object]". At runtime the global is React Native's own polyfill;
// install it here so multipart tests exercise what the device actually sends.
// `globalThis` rather than `global`: this tsconfig only pulls in the jest types,
// so the Node-only `global` binding has no declaration here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
globalThis.FormData = require('react-native/Libraries/Network/FormData').default;

// Reanimated 4 initialises a worklets native module at import time, which does
// not exist under Jest — the import throws before any test runs, and the
// package's own mock re-exports from the real entry point so it fails the same
// way. `test/reanimatedMock.tsx` provides the surface this app uses instead.
// Consequence to keep in mind: animated values do not move in tests, so gesture
// behaviour is verified on the simulator rather than here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-reanimated', () => require('./reanimatedMock'));

// `MediaLibrary.Asset` extends a native class that does not exist outside a
// device runtime, so merely importing expo-media-library throws under Jest —
// and it is reachable from any screen that can save a photo. Mocked globally
// rather than per suite: no test should use the real library, and every code
// path that saves goes through an injectable `NativePhotoActions` anyway.
jest.mock('expo-media-library', () => ({
  Asset: { create: jest.fn(async () => undefined) },
  requestPermissionsAsync: jest.fn(async () => ({
    granted: true,
    canAskAgain: true,
    status: 'granted',
  })),
}));
