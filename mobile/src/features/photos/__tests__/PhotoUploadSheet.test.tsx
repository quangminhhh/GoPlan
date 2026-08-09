import { fireEvent, render, screen } from '@testing-library/react-native';
import { PhotoUploadSheet, uploadSummaryLine } from '../components/PhotoUploadSheet';
import type { UploadSnapshot } from '../uploadSession';
import type { UploadItem, UploadItemState } from '../uploadTypes';

function item(index: number, state: UploadItemState): UploadItem {
  return { id: `pick-${index - 1}`, index, fileName: `IMG_${index}.HEIC`, state };
}

function snapshot(overrides: Partial<UploadSnapshot> = {}): UploadSnapshot {
  return {
    phase: 'selected',
    items: [item(1, 'queued'), item(2, 'queued')],
    selectedCount: 2,
    processedCount: 0,
    uploadedCount: 0,
    rejectedCount: 0,
    pendingCount: 2,
    unknownCount: 0,
    failedCount: 0,
    batchesUploaded: 0,
    activePreparation: null,
    activeBatch: null,
    stopping: false,
    error: null,
    ...overrides,
  };
}

const noop = () => undefined;

describe('uploadSummaryLine', () => {
  it.each([
    ['idle', 'Ready to upload'],
    ['selected', '2 selected'],
    ['paused', 'Upload paused'],
    ['complete', 'Upload complete'],
    ['partial', 'Upload finished with issues'],
    ['throttled', 'Upload limit reached'],
    ['stopped', 'Upload stopped'],
    ['cancelled', 'Upload cancelled'],
    ['tripGone', 'Trip not found'],
  ] as const)('covers the %s phase', (phase, expected) => {
    expect(uploadSummaryLine(snapshot({ phase }))).toBe(expected);
  });

  it('uses the actual processing item order, not processedCount arithmetic', () => {
    expect(
      uploadSummaryLine(
        snapshot({
          phase: 'preprocessing',
          selectedCount: 8,
          processedCount: 6,
          items: [item(2, 'rejected'), item(4, 'processing'), item(8, 'queued')],
        }),
      ),
    ).toBe('Preparing photo 4 of 8');
  });

  it('keeps the active batch item count after currentBatch has been detached', () => {
    expect(
      uploadSummaryLine(
        snapshot({
          phase: 'uploading',
          batchesUploaded: 1,
          activeBatch: {
            number: 2,
            itemCount: 5,
            loadedBytes: 0,
            totalBytes: null,
          },
        }),
      ),
    ).toBe('Uploading batch 2 · 5 photos');
  });
});

describe('PhotoUploadSheet progress and controls', () => {
  it('exposes structured determinate preprocessing progress with one AX progress node', async () => {
    await render(
      <PhotoUploadSheet
        snapshot={snapshot({
          phase: 'preprocessing',
          items: [item(1, 'rejected'), item(2, 'processing'), item(3, 'queued')],
          selectedCount: 3,
          activePreparation: { current: 2, total: 3 },
        })}
        onStart={noop}
        onStop={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText('Preparing photo 2 of 3')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({
      min: 1,
      max: 3,
      now: 2,
    });
  });

  it('renders and clamps known multipart progress with accessibility value', async () => {
    await render(
      <PhotoUploadSheet
        snapshot={snapshot({
          phase: 'uploading',
          items: [item(1, 'uploaded'), item(2, 'uploading'), item(3, 'uploading')],
          selectedCount: 3,
          uploadedCount: 1,
          pendingCount: 0,
          activeBatch: {
            number: 2,
            itemCount: 2,
            loadedBytes: 130,
            totalBytes: 100,
          },
        })}
        onStart={noop}
        onStop={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText('Uploading batch 2 · 2 photos')).toBeTruthy();
    expect(screen.getByText('1 uploaded · 2 remaining')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 100,
    });
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('renders an accessible indeterminate spinner without a percentage', async () => {
    await render(
      <PhotoUploadSheet
        snapshot={snapshot({
          phase: 'uploading',
          activeBatch: {
            number: 1,
            itemCount: 2,
            loadedBytes: 42,
            totalBytes: null,
          },
        })}
        onStart={noop}
        onStop={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByTestId('photo-upload-progress-indeterminate')).toBeTruthy();
    expect(screen.getByLabelText('Uploading batch 1')).toBeTruthy();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toBeUndefined();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('acknowledges Stop immediately with phase-specific copy and a disabled repeat action', async () => {
    const onStop = jest.fn();
    const view = await render(
      <PhotoUploadSheet
        snapshot={snapshot({
          phase: 'preprocessing',
          stopping: true,
          activePreparation: { current: 1, total: 2 },
        })}
        onStart={noop}
        onStop={onStop}
        onClose={noop}
      />,
    );

    expect(screen.getByText('Stopping after current preparation…')).toBeTruthy();
    const preparingStop = screen.getByLabelText('Stopping…');
    expect(preparingStop.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(preparingStop);
    expect(onStop).not.toHaveBeenCalled();

    await view.rerender(
      <PhotoUploadSheet
        snapshot={snapshot({
          phase: 'uploading',
          stopping: true,
          activeBatch: {
            number: 1,
            itemCount: 2,
            loadedBytes: 25,
            totalBytes: 100,
          },
        })}
        onStart={noop}
        onStop={onStop}
        onClose={noop}
      />,
    );
    expect(screen.getByText('Stopping after current upload…')).toBeTruthy();
    expect(screen.getByLabelText('Stopping…').props.accessibilityState.disabled).toBe(true);
  });

  it('does not offer Resume after Stop wins a throttle response', async () => {
    const onClose = jest.fn();
    await render(
      <PhotoUploadSheet
        snapshot={snapshot({
          phase: 'stopped',
          error: { kind: 'throttled', message: 'Upload limit reached. Try again later.' },
        })}
        onStart={noop}
        onStop={noop}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Upload limit reached. Try again later.')).toBeTruthy();
    expect(screen.queryByLabelText('Resume')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers Resume only for paused and throttled resumable phases', async () => {
    const onStart = jest.fn();
    const view = await render(
      <PhotoUploadSheet
        snapshot={snapshot({ phase: 'paused' })}
        onStart={onStart}
        onStop={noop}
        onClose={noop}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Resume'));
    expect(onStart).toHaveBeenCalledTimes(1);

    await view.rerender(
      <PhotoUploadSheet
        snapshot={snapshot({ phase: 'throttled' })}
        onStart={onStart}
        onStop={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByLabelText('Resume')).toBeTruthy();
  });
});
