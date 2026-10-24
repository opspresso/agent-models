import { SIGN_IN_SCOPES } from "../domain/identity.ts";
import { DEFAULT_MAX_STREAM_BUFFER_BYTES, MAX_STREAM_BUFFER_BYTES, MAX_SSE_EVENT_BYTES } from "../infrastructure/providers/sse-guard.ts";

export interface Configuration {
  databaseUrl: string;
  encryptionKey: string;
  authBaseUrl: string;
  authSecret: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  providerId: string;
  scopes: string[];
  inferenceTimeoutMs: number;
  maxConcurrent: number;
  maxRequestBytes: number;
  maxStreamBufferBytes: number;
}

export function readConfiguration(env: Record<string, string | undefined> = process.env): Configuration {
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
  const url = (name: string, originOnly = false) => {
    const value = required(name);
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash ||
        (originOnly && parsed.pathname !== "/")) throw new Error(`${name} must be an HTTP(S) ${originOnly ? "origin" : "URL"} without credentials, query or fragment`);
    return originOnly ? parsed.origin : value;
  };
  const number = (name: string, defaultValue: number, max: number, min = 1) => {
    const value = env[name] === undefined ? defaultValue : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  const authSecret = required("AUTH_SECRET");
  if (authSecret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  const providerId = env.OIDC_PROVIDER_ID?.trim() || "studio";
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(providerId)) throw new Error("Invalid OIDC_PROVIDER_ID");
  const scopes = env.OIDC_SCOPES?.trim().split(/\s+/) ?? [...SIGN_IN_SCOPES];
  if (!["openid", "email", "profile", "platform:identity"].every(scope => scopes.includes(scope))) throw new Error("OIDC_SCOPES must include openid, email, profile and platform:identity");
  return { databaseUrl: required("DATABASE_URL"), encryptionKey: required("AES_ENCRYPTION_KEY"), authBaseUrl: url("AUTH_BASE_URL", true), authSecret,
    issuer: url("OIDC_ISSUER"), clientId: required("OIDC_CLIENT_ID"), clientSecret: required("OIDC_CLIENT_SECRET"), providerId, scopes,
    inferenceTimeoutMs: number("MODEL_REQUEST_TIMEOUT_MS", 600_000, 3_600_000), maxConcurrent: number("MODEL_MAX_CONCURRENT_REQUESTS", 64, 1000),
    maxRequestBytes: number("MODEL_MAX_REQUEST_BYTES", 96 * 1024 * 1024, 256 * 1024 * 1024),
    maxStreamBufferBytes: number("MODEL_MAX_STREAM_BUFFER_BYTES", DEFAULT_MAX_STREAM_BUFFER_BYTES, MAX_STREAM_BUFFER_BYTES, MAX_SSE_EVENT_BYTES) };
}
