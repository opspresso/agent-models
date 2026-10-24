"use client";
import { useEffect, useState } from "react";
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 401) { window.location.assign("/login"); throw new Error("Sign in with Studio"); }
  if (!response.ok) {
    const value = await response.json() as { error?: string | { message?: string } };
    throw new Error(typeof value.error === "string" ? value.error : value.error?.message ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export function useRemote<T>(path: string | null) {
  const [data, setData] = useState<T>(); const [error, setError] = useState<string>(); const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError(undefined);
    if (path) void api<T>(path, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Request failed"); });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, reload: () => setRevision(value => value + 1) };
}
