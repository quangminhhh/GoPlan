import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';

const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;

/** A real AxiosError, which is what normalizeApiError narrows on. */
export function axiosError(status: number, data: unknown): AxiosError {
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    headers: {},
    config,
    data,
  });
}
