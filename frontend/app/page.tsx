"use client";

import { useEffect, useMemo, useState } from "react";

import { checkBackendHealth, type BackendHealth } from "@/lib/api/health";
import { setupInterceptors } from "@/lib/api/interceptors";
import { API_BASE_URL } from "@/lib/api/config";
import { type ApiError } from "@/lib/api/http";

type ConnectionState = "checking" | "connected" | "failed";

export default function Home() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [healthPayload, setHealthPayload] = useState<BackendHealth | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setupInterceptors();
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function verifyConnection() {
      setConnectionState("checking");
      setErrorMessage(null);
      try {
        const payload = await checkBackendHealth();
        if (!isMounted) {
          return;
        }
        setHealthPayload(payload);
        setConnectionState("connected");
      } catch (error) {
        if (!isMounted) {
          return;
        }
        const normalizedError = error as ApiError;
        setErrorMessage(normalizedError.message);
        setConnectionState("failed");
      }
    }

    void verifyConnection();

    return () => {
      isMounted = false;
    };
  }, []);

  const statusText = useMemo(() => {
    if (connectionState === "checking") {
      return "Checking backend connection...";
    }
    if (connectionState === "connected") {
      return "Connected";
    }
    return "Connection failed";
  }, [connectionState]);

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12 text-slate-900">
      <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Frontend-Backend Readiness Check</h1>
        <p className="mt-2 text-sm text-slate-600">
          This page verifies that the frontend can reach the backend health endpoint.
        </p>

        <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-700">Backend URL</p>
          <p className="mt-1 font-mono text-sm text-slate-900">{API_BASE_URL}</p>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-medium text-slate-700">Connection status</p>
          <p className="mt-1 text-lg font-semibold">{statusText}</p>
          {connectionState === "connected" && healthPayload ? (
            <p className="mt-2 text-sm text-slate-600">
              Service: <span className="font-medium">{healthPayload.service}</span> | Timestamp:{" "}
              <span className="font-mono">{healthPayload.timestamp}</span>
            </p>
          ) : null}
          {connectionState === "failed" && errorMessage ? (
            <p className="mt-2 text-sm text-rose-600">Error: {errorMessage}</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
