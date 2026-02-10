import axios from "axios";

import { httpClient, type ApiError } from "@/lib/api/http";

let isInterceptorSetup = false;

export function setupInterceptors() {
  if (isInterceptorSetup) {
    return;
  }

  httpClient.interceptors.request.use((config) => {
    // Auth placeholder: attach Bearer token here when auth state is implemented.
    return config;
  });

  httpClient.interceptors.response.use(
    (response) => response,
    (error: unknown): Promise<never> => {
      if (axios.isAxiosError(error)) {
        const normalizedError: ApiError = {
          status: error.response?.status ?? null,
          message:
            error.response?.data?.detail ??
            error.message ??
            "Unexpected network error.",
          details: error.response?.data,
        };
        return Promise.reject(normalizedError);
      }

      const fallbackError: ApiError = {
        status: null,
        message: "Unexpected network error.",
        details: error,
      };
      return Promise.reject(fallbackError);
    },
  );

  isInterceptorSetup = true;
}
