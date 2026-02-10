import axios from "axios";

import { API_BASE_URL } from "@/lib/api/config";

export type ApiError = {
  status: number | null;
  message: string;
  details?: unknown;
};

export const httpClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10_000,
  withCredentials: false,
  headers: {
    "Content-Type": "application/json",
  },
});
