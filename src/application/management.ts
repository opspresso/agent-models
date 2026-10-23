import { requireAdmin, RouterError } from "../domain/router/errors.ts";
import type { RouterRepository, SecretCipher } from "../domain/router/repository.ts";
import type { ModelDiscovery } from "../domain/router/transport.ts";
import type { Principal, Provider, SelectedModel, UsageQuery } from "../domain/router/types.ts";
import { providerUrl, validateProvider, validateSelection, validIdentifier } from "../domain/router/validation.ts";

export function createManagement(repository: RouterRepository, cipher: SecretCipher, discovery: ModelDiscovery) {
  function scopedUsage(principal: Principal, query: UsageQuery): UsageQuery {
    if (principal.modelCall) throw new RouterError("invocation_grant_only", 403, "This credential may only read its own model request receipt");
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500 ||
        !["model", "user", "agent", "service", "day"].includes(query.groupBy) ||
        !Number.isFinite(Date.parse(query.from)) || !Number.isFinite(Date.parse(query.to)) ||
        Date.parse(query.from) >= Date.parse(query.to) || Date.parse(query.to) - Date.parse(query.from) > 366 * 86400_000) {
      throw new RouterError("invalid_usage_query", 400, "Choose a valid usage period of at most 366 days and a limit between 1 and 500");
    }
    return { ...query, ...(!principal.admin ? { subject: principal.subject } : {}) };
  }
  return {
    providers(principal: Principal) {
      requireAdmin(principal.admin);
      return repository.listProviders();
    },
    async saveProvider(principal: Principal, value: Omit<Provider, "revision" | "updatedAt"> & { secret?: string }, revision: number | null) {
      requireAdmin(principal.admin);
      const { secret, ...provider } = value;
      validateProvider(provider);
      if (secret !== undefined && (secret.length > 8192 || /[\r\n]/.test(secret))) throw new RouterError("invalid_secret", 400, "Invalid provider credential");
      const previous = await repository.getProvider(provider.id);
      const replacement = secret?.trim() && !/^[*•]+$/.test(secret) ? cipher.encrypt(secret, provider.id) : null;
      const encryptedSecret = provider.auth === "secret" ? replacement ?? previous?.encryptedSecret ?? null : null;
      if (provider.auth === "secret" && !encryptedSecret) throw new RouterError("credential_required", 400, "This provider requires a credential");
      return repository.saveProvider({ ...provider, baseUrl: providerUrl(provider.baseUrl), encryptedSecret }, revision);
    },
    models(principal: Principal, includeDisabled = false) {
      if (includeDisabled) requireAdmin(principal.admin);
      return repository.listModels(includeDisabled);
    },
    saveModel(principal: Principal, model: Omit<SelectedModel, "revision" | "updatedAt">, revision: number | null) {
      requireAdmin(principal.admin);
      validateSelection(model);
      return repository.saveModel(model, revision);
    },
    async discover(principal: Principal, providerId: string) {
      requireAdmin(principal.admin);
      const provider = await repository.getProvider(providerId);
      if (!provider) throw new RouterError("provider_not_found", 404, "Provider is not registered");
      const secret = provider.encryptedSecret ? cipher.decrypt(provider.encryptedSecret, provider.id) : null;
      const models = await discovery.discover(provider, secret);
      if (models.length > 10_000 || new Set(models.map(model => model.wireId)).size !== models.length ||
          models.some(model => model.providerId !== provider.id || !validIdentifier(model.wireId) || !model.displayName.trim() || model.displayName.length > 200)) {
        throw new RouterError("invalid_catalog", 502, "Provider returned an invalid model catalog");
      }
      await repository.replaceDiscovered(providerId, models, provider.revision);
      return { discovered: models.length };
    },
    discovered(principal: Principal, providerId: string, limit = 100, after?: string) {
      requireAdmin(principal.admin);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RouterError("invalid_limit", 400, "Limit must be between 1 and 500");
      return repository.listDiscovered(providerId, limit, after);
    },
    usage: (principal: Principal, query: UsageQuery) => repository.usage(scopedUsage(principal, query)),
    usageOverview: (principal: Principal, query: UsageQuery) => repository.usageOverview(scopedUsage(principal, query)),
    async requestUsage(principal: Principal, service: string, requestId: string) {
      if (principal.modelCall && (service !== principal.service || requestId !== principal.modelCall.requestId)) {
        throw new RouterError("request_not_found", 404, "Request is not available");
      }
      const value = await repository.getUsage(service, requestId);
      if (!value || (!principal.admin && value.subject !== principal.subject)) throw new RouterError("request_not_found", 404, "Request is not available");
      return value;
    },
  };
}
