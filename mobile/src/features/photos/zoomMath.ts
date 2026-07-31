export interface ContainedImageSize {
  width: number;
  height: number;
}

export interface PanBounds {
  x: number;
  y: number;
}

export function clampNumber(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

/** Actual pixels occupied by `contentFit="contain"` inside the viewer page. */
export function computeContainedImageSize(
  viewportWidth: number,
  viewportHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ContainedImageSize {
  'worklet';
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return {
      width: Math.max(0, viewportWidth),
      height: Math.max(0, viewportHeight),
    };
  }

  const fitScale = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  return {
    width: sourceWidth * fitScale,
    height: sourceHeight * fitScale,
  };
}

export function computeContainedPanBounds(
  viewportWidth: number,
  viewportHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
): PanBounds {
  'worklet';
  const contained = computeContainedImageSize(
    viewportWidth,
    viewportHeight,
    sourceWidth,
    sourceHeight,
  );
  return {
    x: Math.max(0, (contained.width * scale - viewportWidth) / 2),
    y: Math.max(0, (contained.height * scale - viewportHeight) / 2),
  };
}
