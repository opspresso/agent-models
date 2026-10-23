import type { Admission, DiscoveredModel, Provider, RoutedRequest, SelectedModel, SelectedModelView, Settlement, StoredProvider, UsageOverview, UsageQuery, UsageRecord, UsageSummary } from "./types.ts";

export interface RouterRepository {
  listProviders(): Promise<Provider[]>;
  getProvider(id: string): Promise<StoredProvider | null>;
  saveProvider(provider: Omit<StoredProvider, "revision" | "updatedAt">, expectedRevision: number | null): Promise<Provider>;
  listModels(includeDisabled: boolean): Promise<SelectedModelView[]>;
  saveModel(model: Omit<SelectedModel, "revision" | "updatedAt">, expectedRevision: number | null): Promise<SelectedModel>;
  listDiscovered(providerId: string, limit: number, after?: string): Promise<DiscoveredModel[]>;
  replaceDiscovered(providerId: string, models: DiscoveredModel[], expectedProviderRevision: number): Promise<void>;
  /** Atomically validates current selection and records dispatch intent before any paid work. */
  admit(input: Admission, concurrencyLimit: number): Promise<RoutedRequest>;
  settle(service: string, requestId: string, executionId: string, settlement: Settlement): Promise<void>;
  /** Expired dispatches have an unknown outcome and must never be replayed. */
  expire(): Promise<number>;
  usage(query: UsageQuery): Promise<UsageSummary[]>;
  usageOverview(query: UsageQuery): Promise<UsageOverview>;
  getUsage(service: string, requestId: string): Promise<UsageRecord | null>;
}

export interface SecretCipher {
  encrypt(secret: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}
