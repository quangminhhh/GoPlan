import {
  clampNumber,
  computeContainedImageSize,
  computeContainedPanBounds,
} from '../zoomMath';

describe('contained viewer geometry', () => {
  it('uses the letterboxed image dimensions rather than the full viewport', () => {
    const contained = computeContainedImageSize(430, 932, 4, 3);
    expect(contained.width).toBeCloseTo(430);
    expect(contained.height).toBeCloseTo(322.5);

    const bounds = computeContainedPanBounds(430, 932, 4, 3, 2);
    expect(bounds.x).toBeCloseTo(215);
    // The scaled image is still shorter than the portrait viewport, so there is
    // no legitimate vertical pan at this zoom.
    expect(bounds.y).toBe(0);
  });

  it('re-clamps an old translation when pinch zoom shrinks the bounds', () => {
    const wideZoom = computeContainedPanBounds(430, 932, 4, 3, 4);
    const shrunkZoom = computeContainedPanBounds(430, 932, 4, 3, 2);
    expect(wideZoom.x).toBeGreaterThan(shrunkZoom.x);

    expect(clampNumber(wideZoom.x, -shrunkZoom.x, shrunkZoom.x)).toBe(
      shrunkZoom.x,
    );
  });

  it('falls back safely when server dimensions are malformed', () => {
    expect(computeContainedImageSize(430, 932, 0, 0)).toEqual({
      width: 430,
      height: 932,
    });
  });
});
