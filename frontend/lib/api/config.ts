const RAW_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

if (!RAW_API_BASE_URL) {
  throw new Error(
    "Missing NEXT_PUBLIC_API_BASE_URL. Define it in frontend/.env.local.",
  );
}

export const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");
