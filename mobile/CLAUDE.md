# GoPlan Mobile — Claude Development Guide

## 1. Scope

This file applies to `mobile/` and overrides root `CLAUDE.md` for mobile-specific behavior.

## 2. Stack

- Expo SDK 57 (React Native), TypeScript 5 strict, Expo Router (file-based routing)
- When writing Expo/RN code, consult the versioned docs: https://docs.expo.dev/versions/v57.0.0/
- Styling: React Native `StyleSheet` + design tokens from `src/shared/theme/tokens.ts` — no NativeWind, no UI kits
- HTTP: Axios via `src/shared/api/client.ts` → **direct to Django** (no BFF; the BFF invariant applies to browsers only)
- Auth storage: refresh token in `expo-secure-store` (Keychain/Keystore) only; access token in-memory only. Never AsyncStorage for tokens. (P0)
- This is a native mobile app — no Next.js or web DOM assumptions.

## 3. iPhone 17 Pro Max Simulator Workflow

### Target rules

- The default mobile runtime and QA target is the existing **iPhone 17 Pro Max Simulator** on an installed compatible iOS runtime.
- A physical iPhone is no longer required for normal development. Use one only when the owner explicitly requests physical-device validation.
- Discover available runtimes and devices at the start of a simulator session; select the device by name and never commit its UDID.
- Reuse the existing iPhone 17 Pro Max Simulator. Do not create duplicate devices, download another multi-gigabyte runtime, or update Xcode merely to start a normal session without first reporting the need and obtaining owner approval.
- Never erase or delete a simulator/device/runtime without explicit owner approval. Shutdown is safe and should be used after testing to release RAM while preserving app data.
- Use the installed **GoPlan development build**, not App Store Expo Go. This project uses Expo SDK 57 and native dependencies that require its own development client.

### Preflight and simulator lifecycle

Run from `mobile/` unless a command says otherwise:

```bash
pnpm install
xcrun simctl list runtimes
xcrun simctl list devices available
```

- Confirm that an available `iPhone 17 Pro Max` and a compatible iOS runtime are already installed. If either is missing, report it before downloading or creating anything.
- If `.env` does not exist, copy `.env.example` to `.env`; never overwrite an existing real environment file.
- For the default Simulator workflow, set `EXPO_PUBLIC_API_URL=http://127.0.0.1:8000` in `.env` (no `/api` suffix) and expose the Django service on Mac port `8000`.
- Start the local backend from the repository root with `podman compose up -d backend mailpit`. Verify it with `curl http://127.0.0.1:8000/admin/login/`; HTTP `200` is the current readiness check because this repository has no `/health` route. Workers are not required for basic app startup, but are required for E2E journeys that exercise background jobs.
- Boot only when the target is currently `Shutdown`, then open the Simulator UI and wait until boot completes:

```bash
xcrun simctl boot "iPhone 17 Pro Max"
open -a Simulator
xcrun simctl bootstatus "iPhone 17 Pro Max" -b
```

When XcodeBuildMCP simulator tools are available, prefer them for discovery, native build/debug, accessibility inspection, screenshots, gestures, and logs. Set the workspace to `ios/GoPlan.xcworkspace` (not the `.xcodeproj`), scheme to `GoPlan`, and the runtime-discovered iPhone 17 Pro Max simulator ID; do not persist that ID in the repository. Daily Metro startup still uses `pnpm start`.

### Build and install a new development version

Use this the first time, when the app is missing, or after native code/configuration changes:

```bash
pnpm rebuild:sim
```

The command builds the native iOS app, installs it in the selected Simulator, launches GoPlan, and starts Metro.

A rebuild is required when:

- a dependency containing native iOS code is added, removed, or upgraded;
- `app.json`, an Expo config plugin, entitlements, signing, or files under `ios/` change;
- the development build is missing or must be reinstalled.

A rebuild is **not** required for ordinary TS/TSX/JavaScript changes, Metro-served assets, or an `EXPO_PUBLIC_` value change.

The generated `ios/` directory is ignored. Expo only creates it automatically when it is absent, so after changing `app.json`, an Expo config plugin, or native dependency configuration, explicitly regenerate and then rebuild:

```bash
pnpm prebuild:ios
pnpm rebuild:sim
```

`pnpm prebuild:ios` uses `--clean` and regenerates `ios/`. Before running it, confirm that the generated directory contains no intentional local native edits. Do not run it for ordinary application-code changes. Keep the repository's intentional Expo/React Native ABI pins; do not run blanket `expo install --fix`.

### Daily development (existing dev build; no native rebuild)

```bash
pnpm start
```

- This is the verified one-command workflow. Keep it running in a dedicated terminal or Agent PTY for the whole development/E2E session.
- The script forces Node to resolve `localhost` to IPv4, starts Metro in development-client mode, and uses Expo's `--ios` deep link to open the installed GoPlan build with the current Metro URL.
- Do not replace it with a bare `xcrun simctl launch`: that opens the native binary without supplying the current development-server URL. Do not run `pnpm ios`, `pnpm rebuild:sim`, or Xcode build commands for routine JS/TS work.
- Metro/Fast Refresh handles TS/TSX, JavaScript, styles, assets, and ordinary application logic.
- After changing an `EXPO_PUBLIC_` value, fully reload the development build. Use `pnpm start:clear` only if Metro retains a stale value; it is a fallback, not the default startup command.
- If an Agent sandbox prevents Metro from binding a local port, obtain permission to run `pnpm start` on the host. A sandbox bind failure is not evidence that the iOS app needs rebuilding.

Startup is successful only when all of these are true:

1. Expo prints `Using development build` and `Opening exp+goplan://...127.0.0.1:8081 on iPhone 17 Pro Max`.
2. `curl http://127.0.0.1:8081/status` returns HTTP `200` with `packager-status:running`.
3. The Simulator displays GoPlan application UI rather than Expo Go, the development launcher, or a red connection-error screen. For Agent QA, confirm this with an XcodeBuildMCP UI snapshot or screenshot.

### Release-like smoke build

This validates an embedded production bundle in the Simulator; it is not an App Store/TestFlight release and does not replace final physical-device validation when that is specifically required:

```bash
pnpm exec expo run:ios --device "iPhone 17 Pro Max" --configuration Release --no-bundler
```

Do not change the bundle identifier, Apple team, signing settings, deployment target, or Xcode configuration without owner approval.

### Simulator testing and `@Computer` fallback

Use this order for mobile verification:

1. Run the automated quality commands below.
2. If the repository has a purpose-built simulator E2E runner, use it for repeatable user journeys.
3. Otherwise, prefer XcodeBuildMCP simulator UI/debug tools when available because they expose app UI state, screenshots, gestures, and logs directly.
4. If no suitable E2E or dedicated simulator-control capability is available, use the owner-authorized **`@Computer` (Computer Use)** plugin to control the macOS `Simulator` app after the Debug/Release build launches.

When using `@Computer`:

- target the `Simulator` app and obtain a fresh app-state snapshot before interacting;
- prefer accessibility element indices when exposed; use screenshots and coordinates only when the accessibility tree is incomplete;
- refresh app state after each navigation or mutation instead of reusing stale coordinates;
- exercise the scoped journey with realistic data, including its primary success path, validation/error states, navigation back/forward, and relaunch/session behavior when relevant;
- capture screenshots or logs as evidence and clearly report which checks were automated versus performed through Computer Use.

Computer Use is a UI-control fallback, not a replacement for lint, type checking, unit tests, or an existing deterministic E2E suite.

### Shutdown and troubleshooting

After testing, release simulator resources without deleting data:

```bash
xcrun simctl shutdown "iPhone 17 Pro Max"
```

- **Wrong simulator opens:** inspect `xcrun simctl list devices available`, shut down the unintended device, and explicitly target `iPhone 17 Pro Max`.
- **Red screen / cannot connect to development server:** run `lsof -nP -iTCP:8081 -sTCP:LISTEN`. Metro must listen on `127.0.0.1:8081`, not only `[::1]:8081`. Stop the Agent-owned Metro process and restart with `pnpm start`; do not rebuild the app for this IPv4/IPv6 mismatch.
- **No development server:** run `curl http://127.0.0.1:8081/status`, confirm Django is reachable at `127.0.0.1:8000`, and inspect whether another process owns port `8081`. Do not kill an unrelated process without approval.
- **Expo Go incompatibility:** close Expo Go and launch the installed GoPlan development build.
- **Metro runs but the app does not open:** press `i` in the existing Metro terminal to resend Expo's development-client deep link. If GoPlan is not installed, use `pnpm rebuild:sim`.
- **Stale JavaScript or environment value:** fully reload first; use `pnpm start:clear` only if needed. A duplicate native-view error immediately after Fast Refresh should also get a full reload before any rebuild.
- **Native module/config mismatch:** use `pnpm prebuild:ios` followed by `pnpm rebuild:sim` only when native inputs actually changed or logs identify a missing native module.
- **Missing runtime or device:** stop and report the exact `simctl` output before downloading, creating, erasing, or deleting anything.

Official references: [local app development](https://docs.expo.dev/guides/local-app-development/), [using development builds](https://docs.expo.dev/develop/development-builds/use-development-builds/), and [Expo environment variables](https://docs.expo.dev/guides/environment-variables/).

### Quality commands

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## 4. Code Conventions

- TypeScript strict — no `any`, no unsafe assertions.
- Named exports by default. Exception: files in `src/app/` (Expo Router screens/layouts) use default exports; keep them thin re-exports of components in `src/features/<domain>/screens/`.
- Layout: `src/app/` (routes only) · `src/features/<domain>/` (screens, hooks, api, types) · `src/shared/` (api, ui, theme).
- Business logic must not live in screen components — put it in `src/features/` modules or `src/shared/api`.
- All colors/spacing/typography come from `src/shared/theme/tokens.ts`; no hardcoded values in components.
- Design language is native-first and intentionally independent from the web app's visual style.
- API error handling goes through `normalizeApiError` (`src/shared/api/errors.ts`); display backend messages as returned — never invent more specific ones (no user-enumeration leakage).
- Tests use `@testing-library/react-native` v14 — its render/fireEvent/rerender helpers are async and must be awaited.

## 5. Quality Gates

Every change: `pnpm lint` + `pnpm typecheck` + `pnpm test`.
Auth or navigation-gate changes additionally require a run on the iPhone 17 Pro Max Simulator (login → tabs → relaunch → logout), using dedicated simulator automation or `@Computer` when necessary.

## 6. Skill Usage

- `vercel-react-native-skills` — default for all implementation work in this folder.
- `vercel-composition-patterns` — component API design when needed.
- Web-specific skills (`vercel-react-best-practices` Next.js parts, `web-design-guidelines`) do not apply here.

## 7. Constraints

- The default dev target is the existing iPhone 17 Pro Max Simulator running a GoPlan development build installed via `pnpm rebuild:sim`. Daily development starts with `pnpm start`; do not point users at App Store Expo Go.
- The debug dev build loads its JS bundle from Metro at launch; without a reachable Metro the app shows a connection error. This is expected in development.
- Plain HTTP to `127.0.0.1` is for local Simulator development only; release/TestFlight distribution requires a reachable HTTPS backend.
- Shut down the Simulator after QA to release RAM. Never create/download duplicate runtimes or erase/delete simulator data without owner approval.
