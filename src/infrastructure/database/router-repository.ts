import type { Pool, PoolClient } from "pg";
import { RouterError } from "../../domain/router/errors.ts";
import type { RouterRepository } from "../../domain/router/repository.ts";
import type { Admission, DiscoveredModel, Provider, SelectedModel, Settlement, StoredProvider, UsageQuery, UsageRecord } from "../../domain/router/types.ts";
import { USAGE_UNITS } from "../../domain/router/types.ts";

type ProviderRow = { id: string; configuration: Omit<Provider, "revision" | "updatedAt">; encrypted_secret: string | null; revision: number; updated_at: Date };
type ModelRow = { id: string; provider_id: string; configuration: Omit<SelectedModel, "revision" | "updatedAt">; revision: number; updated_at: Date };
const asProvider = (row: ProviderRow): StoredProvider => ({ ...row.configuration, id: row.id, encryptedSecret: row.encrypted_secret, revision: row.revision, updatedAt: row.updated_at.toISOString() });
const asModel = (row: ModelRow): SelectedModel => ({ ...row.configuration, id: row.id, providerId: row.provider_id, revision: row.revision, updatedAt: row.updated_at.toISOString() });
const publicProvider = (provider: StoredProvider): Provider => {
  return { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, auth: provider.auth,
    enabled: provider.enabled, revision: provider.revision, updatedAt: provider.updatedAt };
};
const conflict = () => new RouterError("revision_conflict", 409, "Configuration changed; reload before saving");

async function expire(client: Pick<PoolClient, "query">): Promise<number> {
  const result = await client.query(`WITH expired AS (
    SELECT service,request_id FROM agent_models_requests WHERE state='running' AND deadline_at<=now()
    ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT 1000
  ) UPDATE agent_models_requests AS request SET state='unknown',finished_at=now(),settlement=jsonb_build_object(
    'outcome','unknown','measurement','unavailable','amounts','{}'::jsonb,'costUsd',NULL,'costSource','unknown',
    'httpStatus',NULL,'errorCode','execution_expired','responseBytes',0,'durationMs',GREATEST(0,EXTRACT(EPOCH FROM now()-request.started_at)*1000))
    FROM expired WHERE request.service=expired.service AND request.request_id=expired.request_id`);
  return result.rowCount ?? 0;
}

export function createRouterRepository(pool: Pool): RouterRepository {
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async function aggregate(client: Pick<PoolClient, "query">, query: UsageQuery, grouped: boolean) {
    const groups = { model: "model_id", user: "subject", agent: "agent_id", service: "service", day: "to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD')" };
    if (!Object.hasOwn(groups, query.groupBy)) throw new RouterError("invalid_usage_query", 400, "Invalid usage grouping");
    const group = grouped ? groups[query.groupBy] : "NULL::text";
    if (!group) throw new RouterError("invalid_usage_query", 400, "Invalid usage grouping");
    const parameters: unknown[] = [query.from, query.to];
    const filters = ["started_at >= $1", "started_at < $2"];
    for (const [column, value] of [["subject", query.subject], ["agent_id", query.agentId], ["model_id", query.modelId], ["service", query.service]]) {
      if (value !== undefined) { parameters.push(value); filters.push(`${column}=$${parameters.length}`); }
    }
    if (grouped && query.after !== undefined) {
      parameters.push(query.after);
      filters.push(`(${group}>$${parameters.length} OR ${group} IS NULL)`);
    }
    parameters.push(query.limit);
    const units = USAGE_UNITS.map((unit, index) => `sum((settlement->'amounts'->>'${unit}')::numeric) AS unit_${index},
      count(settlement->'amounts'->>'${unit}')::int AS unit_${index}_requests`).join(",");
    const rows = await client.query(`SELECT ${group} AS key,count(*)::int AS requests,
      count(*) FILTER(WHERE state='succeeded')::int AS succeeded,count(*) FILTER(WHERE state='failed')::int AS failed,
      count(*) FILTER(WHERE state='cancelled')::int AS cancelled,count(*) FILTER(WHERE state='unknown')::int AS unknown,
      count(*) FILTER(WHERE state='running')::int AS running,count(*) FILTER(WHERE cost_usd IS NULL)::int AS unpriced,
      count(*) FILTER(WHERE settlement->>'measurement'='reported')::int AS measured_requests,
      ${units},COALESCE(sum(cost_usd),0) AS cost_usd
      FROM agent_models_requests WHERE ${filters.join(" AND ")} ${grouped ? `GROUP BY ${group}` : ""} ORDER BY key NULLS LAST LIMIT $${parameters.length}`, parameters);
    return rows.rows.map(row => ({ key: row.key, requests: row.requests, succeeded: row.succeeded, failed: row.failed,
      cancelled: row.cancelled, unknown: row.unknown, running: row.running, unpriced: row.unpriced,
      measuredRequests: row.measured_requests, usage: Object.fromEntries(USAGE_UNITS.flatMap((unit, index) =>
        row[`unit_${index}`] === null ? [] : [[unit, { total: Number(row[`unit_${index}`]), observedRequests: row[`unit_${index}_requests`] }]])), costUsd: Number(row.cost_usd) }));
  }
  return {
    async listProviders() {
      return (await pool.query<ProviderRow>("SELECT * FROM agent_models_providers ORDER BY id LIMIT 50")).rows.map(row => publicProvider(asProvider(row)));
    },
    async getProvider(id) {
      const row = (await pool.query<ProviderRow>("SELECT * FROM agent_models_providers WHERE id=$1", [id])).rows[0];
      return row ? asProvider(row) : null;
    },
    async saveProvider(value, expectedRevision) {
      const { encryptedSecret, ...configuration } = value;
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agent_models_configuration',0))");
        if (expectedRevision === null) {
          const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_models_providers")).rows[0]!.count;
          if (count >= 50) throw new RouterError("provider_limit", 409, "At most 50 providers may be registered");
        }
        const result = expectedRevision === null
          ? await client.query<ProviderRow>("INSERT INTO agent_models_providers(id,configuration,encrypted_secret) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *", [value.id, configuration, encryptedSecret])
          : await client.query<ProviderRow>("UPDATE agent_models_providers SET configuration=$2,encrypted_secret=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING *", [value.id, configuration, encryptedSecret, expectedRevision]);
        if (!result.rows[0]) throw conflict();
        return publicProvider(asProvider(result.rows[0]));
      });
    },
    async listModels(includeDisabled) {
      const rows = await pool.query<ModelRow & { provider_configuration: Provider; provider_revision: number }>(`SELECT model.*,provider.configuration AS provider_configuration,provider.revision AS provider_revision FROM agent_models_selected_models AS model
        JOIN agent_models_providers AS provider ON provider.id=model.provider_id
        ${includeDisabled ? "" : "WHERE (model.configuration->>'enabled')::boolean AND (provider.configuration->>'enabled')::boolean"}
        ORDER BY model.id LIMIT 500`);
      return rows.rows.map(row => ({ ...asModel(row), providerKind: row.provider_configuration.kind, providerName: row.provider_configuration.name, providerEnabled: row.provider_configuration.enabled, providerRevision: row.provider_revision }));
    },
    async saveModel(model, expectedRevision) {
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agent_models_configuration',0))");
        if (!(await client.query("SELECT id FROM agent_models_providers WHERE id=$1", [model.providerId])).rowCount) throw new RouterError("provider_not_found", 404, "Provider is not registered");
        const duplicate = await client.query("SELECT id FROM agent_models_selected_models WHERE provider_id=$1 AND wire_id=$2 AND id<>$3", [model.providerId, model.wireId, model.id]);
        if (duplicate.rowCount) throw new RouterError("model_already_selected", 409, "This provider model is already selected");
        if (expectedRevision === null) {
          const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_models_selected_models")).rows[0]!.count;
          if (count >= 500) throw new RouterError("model_limit", 409, "At most 500 models may be selected");
        }
        const result = expectedRevision === null
          ? await client.query<ModelRow>("INSERT INTO agent_models_selected_models(id,provider_id,wire_id,configuration) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *", [model.id, model.providerId, model.wireId, model])
          : await client.query<ModelRow>("UPDATE agent_models_selected_models SET provider_id=$2,wire_id=$3,configuration=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$5 RETURNING *", [model.id, model.providerId, model.wireId, model, expectedRevision]);
        if (!result.rows[0]) throw conflict();
        return asModel(result.rows[0]);
      });
    },
    async listDiscovered(providerId, limit, after) {
      const rows = await pool.query<{ facts: DiscoveredModel }>(`SELECT facts FROM agent_models_discovered_models
        WHERE provider_id=$1 ${after ? 'AND wire_id COLLATE "C">$3' : ""} ORDER BY wire_id COLLATE "C" LIMIT $2`, after ? [providerId, limit, after] : [providerId, limit]);
      return rows.rows.map(row => row.facts);
    },
    async replaceDiscovered(providerId, models, expectedRevision) {
      await transaction(async client => {
        const provider = (await client.query<{ revision: number }>("SELECT revision FROM agent_models_providers WHERE id=$1 FOR UPDATE", [providerId])).rows[0];
        if (!provider || provider.revision !== expectedRevision) throw conflict();
        await client.query("UPDATE agent_models_discovered_models SET available=false,facts=jsonb_set(facts,'{available}','false') WHERE provider_id=$1", [providerId]);
        if (models.length) await client.query(`INSERT INTO agent_models_discovered_models(provider_id,wire_id,facts,available,observed_at)
          SELECT $1,entry->>'wireId',entry,(entry->>'available')::boolean,(entry->>'observedAt')::timestamptz FROM jsonb_array_elements($2::jsonb) entry
          ON CONFLICT (provider_id,wire_id) DO UPDATE SET facts=EXCLUDED.facts,available=EXCLUDED.available,observed_at=EXCLUDED.observed_at`, [providerId, JSON.stringify(models)]);
      });
    },
    async admit(input: Admission, concurrencyLimit) {
      return transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agent_models_admission',0))");
        await expire(client);
        if ((await client.query("SELECT request_id FROM agent_models_requests WHERE service=$1 AND request_id=$2", [input.principal.service, input.requestId])).rowCount) {
          throw new RouterError("request_already_exists", 409, "This request was already admitted; inspect its usage record instead of replaying it");
        }
        const row = (await client.query<ModelRow & { provider: ProviderRow }>(`SELECT model.*,to_jsonb(provider) AS provider FROM agent_models_selected_models AS model
          JOIN agent_models_providers AS provider ON provider.id=model.provider_id WHERE model.id=$1 FOR SHARE OF model,provider`, [input.modelId])).rows[0];
        if (!row) throw new RouterError("model_unavailable", 404, "Model is not selected");
        const model = asModel(row);
        // to_jsonb carries dates as strings; ordinary row decoding carries Date instances.
        const provider = asProvider({ ...row.provider, updated_at: new Date(row.provider.updated_at) });
        if (!model.enabled || !provider.enabled) throw new RouterError("model_disabled", 403, "Model or provider is disabled");
        if (!model.operations.includes(input.operation)) throw new RouterError("operation_not_allowed", 400, "This operation is not enabled for the selected model");
        const active = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM agent_models_requests WHERE state='running'")).rows[0]!.count;
        if (active >= concurrencyLimit) throw new RouterError("capacity_exceeded", 429, "Model router is at capacity");
        const result = await client.query<{ started_at: Date }>(`INSERT INTO agent_models_requests
          (service,request_id,execution_id,subject,principal_kind,agent_id,model_id,provider_id,operation,model_snapshot,provider_revision,state,deadline_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running',$12) RETURNING started_at`,
        [input.principal.service, input.requestId, input.executionId, input.principal.subject, input.principal.kind, input.principal.agentId ?? null,
          model.id, provider.id, input.operation, model, provider.revision, input.deadlineAt]);
        return { ...input, model, provider, startedAt: result.rows[0]!.started_at.toISOString() };
      });
    },
    async settle(service, requestId, executionId, settlement: Settlement) {
      await transaction(async client => {
        const updated = await client.query(`UPDATE agent_models_requests SET state=$4,settlement=$5,cost_usd=$6,finished_at=now()
          WHERE service=$1 AND request_id=$2 AND execution_id=$3 AND
            (state='running' OR (state='unknown' AND settlement->>'errorCode'='execution_expired'))`,
        [service, requestId, executionId, settlement.outcome, settlement, settlement.costUsd]);
        if (updated.rowCount) return;
        const same = await client.query("SELECT request_id FROM agent_models_requests WHERE service=$1 AND request_id=$2 AND execution_id=$3 AND settlement=$4::jsonb", [service, requestId, executionId, settlement]);
        if (!same.rowCount) throw new RouterError("settlement_conflict", 409, "Request settlement does not match its execution");
      });
    },
    expire: () => expire(pool),
    usage: query => aggregate(pool, query, true),
    usageOverview: query => transaction(async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const groups = await aggregate(client, query, true);
      const totals = (await aggregate(client, query, false))[0]!;
      return { groups, totals };
    }),
    async getUsage(service, requestId): Promise<UsageRecord | null> {
      const row = (await pool.query("SELECT * FROM agent_models_requests WHERE service=$1 AND request_id=$2", [service, requestId])).rows[0];
      return row ? { requestId: row.request_id, service: row.service, subject: row.subject, principalKind: row.principal_kind,
        agentId: row.agent_id, modelId: row.model_id, providerId: row.provider_id, operation: row.operation, state: row.state,
        pricing: row.model_snapshot.pricing, startedAt: row.started_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null, settlement: row.settlement } : null;
    },
  };
}
