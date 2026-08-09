/**
 * Renders a member-only image.
 *
 * The network request is not performed by `expo-image`: the bytes are staged by
 * `protectedAssetStore` and this component only ever points `expo-image` at the
 * resulting local `file://` URI (D1/D3). One consequence is worth stating plainly
 * because it is easy to attribute to the wrong thing — since the source is
 * always local, `expo-image` performs no network fetch for a trip photo and has
 * nothing of its own to persist. `cachePolicy="memory"` is kept as a cheap
 * invariant, not as the privacy boundary; the boundary is the staging lifecycle.
 */

import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type ColorValue,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAppForegroundEffect } from '@/shared/hooks/useAppForegroundEffect';
import { colors, radii, typography } from '@/shared/theme/tokens';
import {
  isPrivateMediaSessionOpen,
  subscribeToPrivateMediaGeneration,
} from './privateMediaLifecycle';
import { acquireProtectedAsset, invalidateProtectedAsset } from './protectedAssetStore';
import {
  isProtectedAssetError,
  ProtectedAssetError,
  type ProtectedAssetVariant,
  type ProtectedTransport,
} from './protectedAssetTypes';

/**
 * A decode failure can mean the staged file was removed between the existence
 * check and the native read. One retry covers that; more would spin forever on a
 * file whose contents are genuinely broken.
 */
const MAX_DECODE_RETRIES = 1;

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; uri: string }
  | { status: 'error'; error: ProtectedAssetError };

export interface AuthenticatedImageProps {
  assetKey: string;
  invalidationPrefix: string;
  path: string;
  variant: ProtectedAssetVariant;
  width: number;
  height: number;
  contentFit: 'cover' | 'contain';
  accessibilityLabel: string;
  /** Keeps a composite owner such as PhotoTile as the only VoiceOver node. */
  accessible?: boolean;
  /** Lets a composite owner expose retry on its own accessibility node. */
  onRetryAvailabilityChange?: (available: boolean) => void;
  /** Incremented by a composite owner when its named retry action is invoked. */
  retryKey?: number;
  /** Source pixel size, used to reserve layout and size the decode. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Overrides the neutral tile surface for contexts such as the dark viewer. */
  backgroundColor?: ColorValue;
  /** Owner branches on `errorCode` — trip-level versus photo-level (D18). */
  onNotFound?: (error: ProtectedAssetError) => void;
  transport?: ProtectedTransport;
}

export function AuthenticatedImage({
  assetKey,
  invalidationPrefix,
  path,
  variant,
  width,
  height,
  contentFit,
  accessibilityLabel,
  accessible = true,
  onRetryAvailabilityChange,
  retryKey = 0,
  sourceWidth,
  sourceHeight,
  backgroundColor,
  onNotFound,
  transport,
}: AuthenticatedImageProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const decodeRetries = useRef(0);
  const notFoundReported = useRef<string | null>(null);

  // Resetting during render rather than from an effect: this is the "adjust
  // state when a prop changes" pattern, and it avoids the cascading extra render
  // a synchronous setState inside an effect would cause.
  const loadKey = `${assetKey}|${path}|${attempt}|${retryKey}`;
  const [renderedLoadKey, setRenderedLoadKey] = useState(loadKey);
  if (renderedLoadKey !== loadKey) {
    setRenderedLoadKey(loadKey);
    setState({ status: 'loading' });
  }

  // Read through a ref so a caller passing an inline arrow does not restart the
  // load on every render.
  const onNotFoundRef = useRef(onNotFound);
  useEffect(() => {
    onNotFoundRef.current = onNotFound;
  }, [onNotFound]);

  useEffect(() => {
    decodeRetries.current = 0;
    notFoundReported.current = null;
  }, [assetKey, path]);

  useEffect(() => {
    // No gate check here on purpose. A closed gate makes `acquireProtectedAsset`
    // reject as cancelled before it touches the network, which lands in the
    // catch below — one path for "not now" instead of two.
    let active = true;
    const controller = new AbortController();
    let acquired: { release(): void } | null = null;

    acquireProtectedAsset({
      assetKey,
      invalidationPrefix,
      path,
      variant,
      signal: controller.signal,
      transport,
    })
      .then((asset) => {
        if (!active) {
          asset.release();
          return;
        }
        acquired = asset;
        setState({ status: 'ready', uri: asset.uri });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const normalized = isProtectedAssetError(error)
          ? error
          : new ProtectedAssetError('network', 'Cannot reach the server. Check your connection.');
        if (normalized.kind === 'cancelled') {
          setState({ status: 'idle' });
          return;
        }
        if (normalized.kind === 'notFound' && notFoundReported.current !== assetKey) {
          notFoundReported.current = assetKey;
          onNotFoundRef.current?.(normalized);
        }
        setState({ status: 'error', error: normalized });
      });

    return () => {
      active = false;
      controller.abort();
      acquired?.release();
    };
  }, [assetKey, invalidationPrefix, path, variant, transport, attempt, retryKey]);

  // A purge clears the local URI immediately; the reacquire only happens once
  // the gate is open again, which for a background purge means after foreground.
  useEffect(
    () =>
      subscribeToPrivateMediaGeneration(() => {
        setAttempt((current) => current + 1);
      }),
    [],
  );

  // Raw AppState is deliberately not a trigger on its own: the lifecycle decides
  // when reacquiring is safe, and it publishes a generation at that point.
  useAppForegroundEffect(
    useCallback(() => {
      if (isPrivateMediaSessionOpen()) {
        setAttempt((current) => current + 1);
      }
    }, []),
  );

  const retry = useCallback(() => {
    decodeRetries.current = 0;
    setAttempt((current) => current + 1);
  }, []);

  const retryAvailable =
    state.status === 'error' &&
    (state.error.kind === 'network' || state.error.kind === 'throttled');
  useEffect(() => {
    onRetryAvailabilityChange?.(retryAvailable);
  }, [onRetryAvailabilityChange, retryAvailable]);

  const handleDecodeError = useCallback(() => {
    if (decodeRetries.current >= MAX_DECODE_RETRIES) {
      setState({
        status: 'error',
        error: new ProtectedAssetError('invalidContent', 'This image could not be loaded.'),
      });
      return;
    }
    decodeRetries.current += 1;
    void invalidateProtectedAsset(assetKey).then(() => {
      setAttempt((current) => current + 1);
    });
  }, [assetKey]);

  const frame = { width, height };
  const background = backgroundColor ? { backgroundColor } : null;

  if (state.status === 'ready') {
    return (
      <Image
        source={{
          uri: state.uri,
          ...(sourceWidth !== undefined ? { width: sourceWidth } : {}),
          ...(sourceHeight !== undefined ? { height: sourceHeight } : {}),
        }}
        style={[styles.image, frame, background]}
        contentFit={contentFit}
        // RAM only. Never 'disk' or 'memory-disk' for member-only content (D3).
        cachePolicy="memory"
        recyclingKey={assetKey}
        accessible={accessible}
        accessibilityElementsHidden={!accessible}
        importantForAccessibility={accessible ? 'auto' : 'no-hide-descendants'}
        accessibilityRole={accessible ? 'image' : undefined}
        accessibilityLabel={accessible ? accessibilityLabel : undefined}
        onError={handleDecodeError}
        testID={accessible ? `authenticated-image-${assetKey}` : undefined}
      />
    );
  }

  if (state.status === 'error') {
    const retriable = state.error.kind === 'network' || state.error.kind === 'throttled';
    return (
      <View
        accessibilityElementsHidden={!accessible}
        importantForAccessibility={accessible ? 'auto' : 'no-hide-descendants'}
        style={[styles.placeholder, frame, background]}
        testID={accessible ? `authenticated-image-error-${assetKey}` : undefined}
      >
        {retriable ? (
          <Pressable
            accessible={accessible}
            accessibilityRole="button"
            accessibilityLabel={accessible ? 'Retry loading this image' : undefined}
            onPress={retry}
            style={styles.retry}
          >
            <Text accessible={false} style={styles.retryLabel}>Retry</Text>
          </Pressable>
        ) : (
          <Text
            accessible={accessible}
            // Says what happened without echoing a path or an identifier.
            accessibilityLabel={accessible ? 'Image unavailable' : undefined}
            style={styles.unavailable}
          >
            Unavailable
          </Text>
        )}
      </View>
    );
  }

  // Fixed size from the very first paint, so the grid never reflows as tiles
  // resolve.
  return (
    <View
      accessibilityElementsHidden={!accessible}
      importantForAccessibility={accessible ? 'auto' : 'no-hide-descendants'}
      style={[styles.placeholder, frame, background]}
      testID={accessible ? `authenticated-image-placeholder-${assetKey}` : undefined}
    >
      {state.status === 'loading' ? <ActivityIndicator color={colors.textMuted} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
  },
  placeholder: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    justifyContent: 'center',
  },
  retry: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryLabel: {
    ...typography.label,
    color: colors.primary,
  },
  unavailable: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
