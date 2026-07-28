process.env.EXPO_PUBLIC_API_URL = 'http://testserver:8000';

// The jest environment's built-in FormData stringifies non-Blob values, so a
// React Native `{uri, name, type}` file part would silently become
// "[object Object]". At runtime the global is React Native's own polyfill;
// install it here so multipart tests exercise what the device actually sends.
// `globalThis` rather than `global`: this tsconfig only pulls in the jest types,
// so the Node-only `global` binding has no declaration here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
globalThis.FormData = require('react-native/Libraries/Network/FormData').default;
