jest.mock('@/shared/api/client', () => ({
  apiClient: {
    delete: jest.fn(),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { apiClient } from '@/shared/api/client';
// eslint-disable-next-line import/first
import {
  createActivity,
  createCustomType,
  createSection,
  deleteActivity,
  deleteCustomType,
  deleteSection,
  getTimeline,
  patchActivity,
  patchCustomType,
  patchSection,
  updateActivityStatus,
} from '../api';

const mockDelete = apiClient.delete as jest.MockedFunction<
  typeof apiClient.delete
>;
const mockGet = apiClient.get as jest.MockedFunction<typeof apiClient.get>;
const mockPatch = apiClient.patch as jest.MockedFunction<
  typeof apiClient.patch
>;
const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;

describe('timeline api', () => {
  beforeEach(() => jest.clearAllMocks());

  it('gets the aggregate timeline directly with cancellation support', async () => {
    const controller = new AbortController();
    const timeline = {
      trip_timezone: 'Asia/Ho_Chi_Minh',
      permissions: {
        can_edit_timeline: true,
        can_manage_custom_types: true,
        can_create_sections: true,
      },
      system_types: [],
      custom_types: [],
      sections: [],
    };
    mockGet.mockResolvedValue({ data: timeline } as never);

    await expect(
      getTimeline('trip-1', controller.signal),
    ).resolves.toEqual(timeline);
    expect(mockGet).toHaveBeenCalledWith('/trips/trip-1/timeline', {
      signal: controller.signal,
    });
  });

  it('creates a section and unwraps the runtime section envelope', async () => {
    const section = {
      id: 'section-1',
      section_date: '2026-08-01',
      label: 'Day 1',
    };
    const payload = {
      section_date: '2026-08-01',
      label: 'Arrival',
    };
    mockPost.mockResolvedValue({ data: { section } } as never);

    await expect(createSection('trip-1', payload)).resolves.toEqual(section);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/sections',
      payload,
    );
  });

  it('patches a section and unwraps the runtime section envelope', async () => {
    const section = { id: 'section-1', label: 'Arrival day' };
    const payload = { label: 'Arrival day' };
    mockPatch.mockResolvedValue({ data: { section } } as never);

    await expect(
      patchSection('trip-1', 'section-1', payload),
    ).resolves.toEqual(section);
    expect(mockPatch).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/sections/section-1',
      payload,
    );
  });

  it('deletes a section through the endpoint that returns HTTP 200 with an empty object', async () => {
    mockDelete.mockResolvedValue({ data: {} } as never);

    await expect(
      deleteSection('trip-1', 'section-1'),
    ).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/sections/section-1',
    );
  });

  it('creates an activity and unwraps the runtime activity envelope', async () => {
    const activity = { id: 'activity-1', title: 'Breakfast' };
    const payload = {
      title: 'Breakfast',
      time_mode: 'AT_TIME' as const,
      start_time: '08:00',
      system_type: 'FOOD' as const,
    };
    mockPost.mockResolvedValue({ data: { activity } } as never);

    await expect(
      createActivity('trip-1', 'section-1', payload),
    ).resolves.toEqual(activity);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/sections/section-1/activities',
      payload,
    );
  });

  it('patches an activity and unwraps the runtime activity envelope', async () => {
    const activity = { id: 'activity-1', title: 'Brunch' };
    const payload = { title: 'Brunch', start_time: null };
    mockPatch.mockResolvedValue({ data: { activity } } as never);

    await expect(
      patchActivity('trip-1', 'activity-1', payload),
    ).resolves.toEqual(activity);
    expect(mockPatch).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/activities/activity-1',
      payload,
    );
  });

  it('deletes an activity through the endpoint that returns HTTP 200 with an empty object', async () => {
    mockDelete.mockResolvedValue({ data: {} } as never);

    await expect(
      deleteActivity('trip-1', 'activity-1'),
    ).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/activities/activity-1',
    );
  });

  it('updates activity status and returns the direct status response', async () => {
    const payload = { status: 'DONE' as const };
    const result = { activity_id: 'activity-1', status: 'DONE' as const };
    mockPost.mockResolvedValue({ data: result } as never);

    await expect(
      updateActivityStatus('trip-1', 'activity-1', payload),
    ).resolves.toEqual(result);
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/activities/activity-1/status',
      payload,
    );
  });

  it('creates a custom type and unwraps the runtime custom_type envelope', async () => {
    const customType = {
      id: 'type-1',
      name: 'Coffee stop',
      normalized_name: 'coffee-stop',
      color_token: 'amber',
      icon_key: 'cafe',
      is_active: true,
    };
    const payload = {
      name: 'Coffee stop',
      color_token: 'amber',
      icon_key: 'cafe',
    };
    mockPost.mockResolvedValue({
      data: { custom_type: customType },
    } as never);

    await expect(createCustomType('trip-1', payload)).resolves.toEqual(
      customType,
    );
    expect(mockPost).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/custom-types',
      payload,
    );
  });

  it('patches a custom type and unwraps the runtime custom_type envelope', async () => {
    const customType = {
      id: 'type-1',
      name: 'Cafe',
      normalized_name: 'cafe',
      color_token: 'amber',
      icon_key: 'cafe',
      is_active: false,
    };
    const payload = { name: 'Cafe', is_active: false };
    mockPatch.mockResolvedValue({
      data: { custom_type: customType },
    } as never);

    await expect(
      patchCustomType('trip-1', 'type-1', payload),
    ).resolves.toEqual(customType);
    expect(mockPatch).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/custom-types/type-1',
      payload,
    );
  });

  it('deletes a custom type through the endpoint that returns HTTP 200 with an empty object', async () => {
    mockDelete.mockResolvedValue({ data: {} } as never);

    await expect(
      deleteCustomType('trip-1', 'type-1'),
    ).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith(
      '/trips/trip-1/timeline/custom-types/type-1',
    );
  });

  it('lets API failures propagate for callers to normalize', async () => {
    const failure = new Error('request failed');
    mockGet.mockRejectedValue(failure);

    await expect(getTimeline('trip-1')).rejects.toBe(failure);
  });
});
