jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  return { Image: View };
});

// eslint-disable-next-line import/first
import type { ComponentProps } from 'react';
// eslint-disable-next-line import/first
import { fireEvent, render, screen } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import { CoverImageField } from '../components/CoverImageField';

const COVER_URL = '/media/trip-covers/8f0e.webp';

async function renderField(
  overrides: Partial<ComponentProps<typeof CoverImageField>> = {},
) {
  const props = {
    coverUrl: '',
    status: 'idle' as const,
    error: null,
    onChoose: jest.fn(),
    onRemove: jest.fn(),
    ...overrides,
  };
  await render(<CoverImageField {...props} />);
  return props;
}

describe('CoverImageField', () => {
  it('offers only a choose action while the trip has no cover', async () => {
    const props = await renderField();

    expect(screen.getByText('No cover photo yet')).toBeTruthy();
    expect(screen.queryByLabelText('Remove photo')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Choose photo'));
    expect(props.onChoose).toHaveBeenCalledTimes(1);
  });

  it('previews an existing cover and offers replace and remove', async () => {
    const props = await renderField({ coverUrl: COVER_URL });

    expect(screen.getByLabelText('Trip cover preview')).toBeTruthy();
    expect(screen.queryByText('No cover photo yet')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Replace photo'));
    await fireEvent.press(screen.getByLabelText('Remove photo'));
    expect(props.onChoose).toHaveBeenCalledTimes(1);
    expect(props.onRemove).toHaveBeenCalledTimes(1);
  });

  it.each(['picking', 'uploading'] as const)(
    'announces progress and swallows presses while %s',
    async (status) => {
      const props = await renderField({ coverUrl: COVER_URL, status });

      expect(screen.getByLabelText('Uploading cover')).toBeTruthy();
      await fireEvent.press(screen.getByLabelText('Replace photo'));
      await fireEvent.press(screen.getByLabelText('Remove photo'));

      expect(props.onChoose).not.toHaveBeenCalled();
      expect(props.onRemove).not.toHaveBeenCalled();
      expect(
        screen.getByLabelText('Replace photo').props.accessibilityState,
      ).toEqual(expect.objectContaining({ disabled: true }));
    },
  );

  it('renders an error as an alert while keeping retry available', async () => {
    const props = await renderField({ error: 'Unsupported image format.' });

    expect(screen.getByText('Unsupported image format.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Choose photo'));
    expect(props.onChoose).toHaveBeenCalledTimes(1);
  });
});
