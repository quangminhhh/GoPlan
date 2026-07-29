import { apiClient } from '@/shared/api/client';
import type { UploadableFile } from './types';

/**
 * React Native's FormData accepts a `{uri, name, type}` object as a file part and
 * streams the file off disk; there is no web Blob involved. The DOM lib that the
 * Expo tsconfig pulls in only models `string | Blob`, which is why this single
 * cast exists — the runtime shape is correct, the ambient type is not.
 */
export function buildUploadFormData(field: string, file: UploadableFile): FormData {
  const form = new FormData();
  form.append(field, file as unknown as Blob);
  return form;
}

export interface UploadFileOptions {
  /**
   * Only for uploads whose payload cannot finish inside the client's 15s default
   * on a mobile connection. Omit it and the instance default applies — axios
   * treats an undefined per-request timeout as "use the instance value".
   */
  timeoutMs?: number;
}

/**
 * Content-Type is deliberately left unset. Axios passes FormData through its
 * transform untouched without adding a header, and React Native's
 * XMLHttpRequest then sets `multipart/form-data; boundary=...`. Setting the
 * header by hand drops the boundary and the body becomes unparseable server-side.
 *
 * The timeout rides in the request config rather than in a second axios client,
 * so an upload retried after a 401 refresh keeps it, and keeps the auth
 * interceptors with it.
 */
export async function uploadFile<T>(
  path: string,
  field: string,
  file: UploadableFile,
  method: 'post' | 'patch' = 'patch',
  options: UploadFileOptions = {},
): Promise<T> {
  const { data } = await apiClient.request<T>({
    url: path,
    method,
    data: buildUploadFormData(field, file),
    timeout: options.timeoutMs,
  });
  return data;
}
