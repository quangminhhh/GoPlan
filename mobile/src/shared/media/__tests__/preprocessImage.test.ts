import { ImagePreprocessError, type ImageCodec, type PickedImage } from '../types';
import { outputFileName, preprocessImage, scaledDimensions } from '../preprocessImage';

const source: PickedImage = { uri: 'file:///src.heic', width: 4032, height: 3024, fileName: 'IMG_0042.HEIC' };
const target = { maxEdgePx: 512, maxBytes: 500 * 1024 };

/** Fake codec whose encoded size is driven by the quality it is handed. */
function codecReturning(bytesByQuality: Record<number, number>): ImageCodec {
  return {
    encode: jest.fn(async ({ width, height, quality }) => ({
      uri: `file:///out-${quality}.jpg`,
      width,
      height,
      bytes: bytesByQuality[quality],
    })),
  };
}

describe('scaledDimensions', () => {
  it('scales the long edge down and preserves the aspect ratio', () => {
    expect(scaledDimensions(4032, 3024, 512)).toEqual({ width: 512, height: 384 });
  });

  it('leaves dimensions untouched when already inside the budget', () => {
    expect(scaledDimensions(400, 300, 512)).toEqual({ width: 400, height: 300 });
  });

  it('never scales an edge below one pixel', () => {
    expect(scaledDimensions(4000, 1, 512)).toEqual({ width: 512, height: 1 });
  });
});

describe('outputFileName', () => {
  it('replaces the source extension with the chosen format', () => {
    expect(outputFileName('IMG_0042.HEIC', 'image/jpeg')).toBe('IMG_0042.jpg');
  });

  it('falls back to a stable name when the picker reports none', () => {
    expect(outputFileName(null, 'image/jpeg')).toBe('photo.jpg');
  });

  it('strips characters that would break a Content-Disposition filename', () => {
    expect(outputFileName('holiday photo/2026.png', 'image/webp')).toBe('holiday_photo_2026.webp');
  });
});

describe('preprocessImage', () => {
  it('returns the first quality step that fits the byte budget', async () => {
    const codec = codecReturning({ 0.9: 80_000 });

    const result = await preprocessImage(source, target, codec);

    expect(codec.encode).toHaveBeenCalledTimes(1);
    expect(codec.encode).toHaveBeenCalledWith({
      uri: 'file:///src.heic',
      width: 512,
      height: 384,
      quality: 0.9,
      format: 'image/jpeg',
    });
    expect(result).toEqual({
      uri: 'file:///out-0.9.jpg',
      name: 'IMG_0042.jpg',
      type: 'image/jpeg',
      width: 512,
      height: 384,
      bytes: 80_000,
    });
  });

  it('steps 0.9 then 0.8 then 0.7 and stops at the first fit', async () => {
    const codec = codecReturning({ 0.9: 900_000, 0.8: 600_000, 0.7: 300_000 });

    const result = await preprocessImage(source, target, codec);

    expect(codec.encode).toHaveBeenCalledTimes(3);
    expect(result.bytes).toBe(300_000);
    expect(result.uri).toBe('file:///out-0.7.jpg');
  });

  it('fails with BUDGET_UNREACHABLE when every quality step overshoots', async () => {
    const codec = codecReturning({ 0.9: 900_000, 0.8: 800_000, 0.7: 700_000 });

    await expect(preprocessImage(source, target, codec)).rejects.toMatchObject({
      name: 'ImagePreprocessError',
      code: 'BUDGET_UNREACHABLE',
    });
    expect(codec.encode).toHaveBeenCalledTimes(3);
  });

  it('fails with UNREADABLE when the codec cannot decode the source', async () => {
    const codec: ImageCodec = { encode: jest.fn(async () => { throw new Error('decode failed'); }) };

    await expect(preprocessImage(source, target, codec)).rejects.toBeInstanceOf(ImagePreprocessError);
    await expect(preprocessImage(source, target, codec)).rejects.toMatchObject({ code: 'UNREADABLE' });
  });

  it('honours an explicit output format', async () => {
    const codec = codecReturning({ 0.9: 10_000 });

    const result = await preprocessImage(source, target, codec, 'image/png');

    expect(result.type).toBe('image/png');
    expect(result.name).toBe('IMG_0042.png');
  });
});
