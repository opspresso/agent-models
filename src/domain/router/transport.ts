import type { DiscoveredModel, Measurement, Operation, SelectedModel, StoredProvider, UsageAmounts } from "./types.ts";

export type InferenceBody = { kind: "json"; value: Record<string, unknown> } | {
  kind: "multipart";
  parts: Array<{ name: string; value: string | Uint8Array; filename?: string; contentType?: string }>;
};

export interface Observation {
  amounts: UsageAmounts;
  measurement: Exclude<Measurement, "not_started">;
  complete: boolean;
  errorCode: string | null;
}

export interface InferenceTransport {
  execute(input: {
    model: SelectedModel;
    provider: StoredProvider;
    secret: string | null;
    operation: Operation;
    body: InferenceBody;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
    onDispatch(): void;
  }): Promise<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: AsyncIterable<Uint8Array>;
    observation(): Observation;
  }>;
}

export interface ModelDiscovery {
  discover(provider: StoredProvider, secret: string | null): Promise<DiscoveredModel[]>;
}
