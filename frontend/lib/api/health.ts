import { httpClient } from "@/lib/api/http";

export type BackendHealth = {
  status: "ok";
  service: string;
  timestamp: string;
};

export async function checkBackendHealth(): Promise<BackendHealth> {
  const response = await httpClient.get<BackendHealth>("/api/health");
  return response.data;
}
