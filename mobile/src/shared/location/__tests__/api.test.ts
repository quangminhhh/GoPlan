jest.mock('@/shared/api/client', () => ({
  apiClient: {
    get: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import { lookupLocation, suggestLocations } from '../api';

const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;

describe('shared location api', () => {
  beforeEach(() => jest.clearAllMocks());

  it('suggests locations and unwraps suggestions with cancellation support', async () => {
    const controller = new AbortController();
    const suggestions = [
      {
        provider: 'here',
        provider_id: 'here:place:1',
        title: 'Da Nang',
        subtitle: 'Vietnam',
      },
    ];
    mockGet.mockResolvedValue({ data: { suggestions } } as never);

    await expect(
      suggestLocations('Da Nang', controller.signal),
    ).resolves.toEqual(suggestions);
    expect(mockGet).toHaveBeenCalledWith('/location-search/suggest', {
      params: { q: 'Da Nang' },
      signal: controller.signal,
    });
  });

  it('looks up a canonical location from the direct response with cancellation support', async () => {
    const controller = new AbortController();
    const lookup = {
      destination: 'Da Nang, Vietnam',
      destination_provider: 'here',
      destination_provider_id: 'here:place:canonical',
      destination_lat: 16.0544,
      destination_lng: 108.2022,
      destination_country_code: 'VN',
    };
    mockGet.mockResolvedValue({ data: lookup } as never);

    await expect(
      lookupLocation('here:place:1', controller.signal),
    ).resolves.toEqual(lookup);
    expect(mockGet).toHaveBeenCalledWith('/location-search/lookup', {
      params: { id: 'here:place:1' },
      signal: controller.signal,
    });
  });
});
