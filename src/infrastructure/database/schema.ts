import type { Pool } from "pg";
import { AUTH_SCHEMA_STATEMENTS } from "./auth-schema.ts";

export const SCHEMA_VERSION = 1;
export const SCHEMA_STATEMENTS = [
  ...AUTH_SCHEMA_STATEMENTS,
  `CREATE TABLE agent_models_providers (
    id text PRIMARY KEY, configuration jsonb NOT NULL, encrypted_secret text,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE agent_models_selected_models (
    id text PRIMARY KEY, provider_id text NOT NULL REFERENCES agent_models_providers(id), wire_id text NOT NULL,
    configuration jsonb NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider_id, wire_id)
  )`,
  `CREATE TABLE agent_models_discovered_models (
    provider_id text NOT NULL REFERENCES agent_models_providers(id), wire_id text NOT NULL,
    facts jsonb NOT NULL, available boolean NOT NULL, observed_at timestamptz NOT NULL,
    PRIMARY KEY (provider_id, wire_id)
  )`,
  `CREATE TABLE agent_models_requests (
    service text NOT NULL, request_id text NOT NULL, execution_id text NOT NULL,
    subject text NOT NULL, principal_kind text NOT NULL CHECK (principal_kind IN ('user','service')), agent_id text,
    model_id text NOT NULL, provider_id text NOT NULL, operation text NOT NULL,
    model_snapshot jsonb NOT NULL, provider_revision integer NOT NULL,
    state text NOT NULL CHECK (state IN ('running','succeeded','failed','cancelled','unknown')),
    started_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz NOT NULL, finished_at timestamptz,
    settlement jsonb, cost_usd numeric(36,18) CHECK (cost_usd >= 0),
    PRIMARY KEY (service, request_id),
    CHECK ((state = 'running' AND settlement IS NULL AND finished_at IS NULL) OR
      (state <> 'running' AND settlement IS NOT NULL AND finished_at IS NOT NULL))
  )`,
  `CREATE INDEX agent_models_requests_deadline_idx ON agent_models_requests(deadline_at) WHERE state = 'running'`,
  `CREATE INDEX agent_models_requests_period_idx ON agent_models_requests(started_at)`,
  `CREATE INDEX agent_models_requests_user_idx ON agent_models_requests(subject, started_at)`,
  `CREATE INDEX agent_models_requests_model_idx ON agent_models_requests(model_id, started_at)`,
  `CREATE INDEX agent_models_requests_agent_idx ON agent_models_requests(agent_id, started_at) WHERE agent_id IS NOT NULL`,
] as const;

/** Initializes only Models-owned tables, beside existing sibling service data. */
export async function initializeSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agent-platform-schema',0))");
    await client.query("CREATE TABLE IF NOT EXISTS agent_models_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const versions = (await client.query<{ version: number }>("SELECT version FROM agent_models_schema ORDER BY version")).rows;
    if (versions.length === 0) {
      const existing = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND starts_with(table_name,'agent_models_') AND table_name<>'agent_models_schema' LIMIT 1");
      if (existing.rowCount) throw new Error("Models tables exist without a recognized schema; refusing to overwrite data");
      for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
      await client.query("INSERT INTO agent_models_schema(version) VALUES ($1)", [SCHEMA_VERSION]);
    } else if (versions.length !== 1 || versions[0]?.version !== SCHEMA_VERSION) {
      throw new Error("Unsupported Models schema version");
    }
    const expected = ["agent_models_account", "agent_models_discovered_models", "agent_models_providers", "agent_models_requests", "agent_models_schema", "agent_models_selected_models", "agent_models_session", "agent_models_user", "agent_models_verification"];
    const tables = (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND starts_with(table_name,'agent_models_') ORDER BY table_name")).rows;
    if (JSON.stringify(tables.map(row => row.table_name)) !== JSON.stringify(expected)) throw new Error("Models schema does not match its owned table set");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
