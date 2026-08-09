import { mergeTripPhotoFirstPage } from '../photoListReconcile';
import type { TripPhoto } from '../types';

function photo(id: string, uploaderName = id): TripPhoto {
  return {
    id,
    created_at: '2026-07-31T10:00:00Z',
    uploaded_by: {
      id: `user-${id}`,
      display_name: uploaderName,
      identify_tag: id,
      avatar_url: null,
    },
    width: 4032,
    height: 3024,
    thumbnail_width: 480,
    thumbnail_height: 360,
    medium_width: 2560,
    medium_height: 1920,
    can_delete: true,
  };
}

describe('mergeTripPhotoFirstPage', () => {
  it('puts fresh page order first and preserves the loaded deep tail', () => {
    const result = mergeTripPhotoFirstPage(
      [photo('old-1'), photo('old-2'), photo('deep-1'), photo('deep-2')],
      [photo('new'), photo('old-1')],
    );

    expect(result.map(({ id }) => id)).toEqual([
      'new',
      'old-1',
      'old-2',
      'deep-1',
      'deep-2',
    ]);
  });

  it('uses the fresh payload for duplicate ids', () => {
    const result = mergeTripPhotoFirstPage(
      [photo('p1', 'Old payload'), photo('p2')],
      [photo('p1', 'Fresh payload')],
    );

    expect(result[0]?.uploaded_by.display_name).toBe('Fresh payload');
    expect(result.map(({ id }) => id)).toEqual(['p1', 'p2']);
  });

  it('does not infer a tombstone from ordinary page-one absence', () => {
    expect(mergeTripPhotoFirstPage([photo('deep')], []).map(({ id }) => id)).toEqual([
      'deep',
    ]);
  });

  it('drops explicit tombstones and de-duplicates malformed input', () => {
    const result = mergeTripPhotoFirstPage(
      [photo('p1'), photo('p2'), photo('p2')],
      [photo('p1'), photo('p1'), photo('p3')],
      new Set(['p2']),
    );

    expect(result.map(({ id }) => id)).toEqual(['p1', 'p3']);
  });
});
