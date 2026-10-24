import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { initializeSchema } from "../src/infrastructure/database/schema.ts";
import { createRouterRepository } from "../src/infrastructure/database/router-repository.ts";
import { createSecretCipher } from "../src/infrastructure/crypto/secret-cipher.ts";
import { createManagement } from "../src/application/management.ts";
import { createInference } from "../src/application/inference.ts";
import type { Admission, DiscoveredModel, Principal, SelectedModel, Settlement } from "../src/domain/router/types.ts";
import { providerCredentialContext } from "../src/domain/router/validation.ts";
import { checkProviderHttp } from "./provider-check.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL to a local disposable *_test database");
const target = new Client({ connectionString });
if (!["localhost", "127.0.0.1"].includes(target.host) || !target.database?.endsWith("_test")) throw new Error("Refusing to test a non-local or non-test database");
const schema = `models_router_${randomUUID().replaceAll("-", "")}`;
const owner = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });

async function check() {
  await owner.query(`CREATE SCHEMA "${schema}"`);
  try {
    await pool.query("CREATE TABLE agent_studio_fixture(id text PRIMARY KEY); INSERT INTO agent_studio_fixture VALUES ('preserved')");
    await Promise.all([initializeSchema(pool), initializeSchema(pool)]);
    const repository = createRouterRepository(pool);
    const cipher = createSecretCipher(Buffer.alloc(32, 7).toString("base64"));
    const admin: Principal = { subject: "admin", kind: "user", service: "agent-studio", admin: true, canInvoke: true };
    const member: Principal = { subject: "member", kind: "user", service: "agent-studio", admin: false, canInvoke: true, agentId: "agent-one" };
    const discovered = { providerId: "local", wireId: "fixture-model", displayName: "Fixture", type: "text", contextWindow: 8192,
      maxTokens: 1024, capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
      pricing: { inputPer1M: 2, outputPer1M: 6 }, available: true, observedAt: new Date().toISOString() } satisfies DiscoveredModel;
    const management = createManagement(repository, cipher, { discover: async () => [discovered] });
    const configuration = { id: "local", name: "Local provider", kind: "selfhosted" as const, baseUrl: "http://127.0.0.1:9999/v1", auth: "secret" as const, enabled: true };
    await assert.rejects(management.saveProvider(member, { ...configuration, secret: "fixture-provider-key" }, null), { code: "admin_required" });
    const provider = await management.saveProvider(admin, { ...configuration, secret: "fixture-provider-key" }, null);
    assert.equal(Object.hasOwn(provider, "encryptedSecret"), false);
    assert.equal(JSON.stringify(await management.providers(admin)).includes("fixture-provider-key"), false);
    const stored = await repository.getProvider("local");
    assert.ok(stored?.encryptedSecret);
    assert.equal(cipher.decrypt(stored.encryptedSecret, providerCredentialContext(stored)), "fixture-provider-key");
    const updated = await management.saveProvider(admin, { ...configuration, secret: "********" }, provider.revision);
    assert.equal((await repository.getProvider("local"))?.encryptedSecret, stored.encryptedSecret, "masked edit preserves the credential");
    await assert.rejects(management.saveProvider(admin, { ...configuration, baseUrl: "https://other.example.test/v1", secret: "********" }, updated.revision),
      { code: "credential_required" }, "a masked credential must not move to another recipient");
    await assert.rejects(management.saveProvider(admin, configuration, provider.revision), { code: "revision_conflict" });
    await management.discover(admin, "local");
    assert.equal((await management.discovered(admin, "local")).length, 1);
    assert.deepEqual(await management.models(member), [], "discovery never enables a model");
    const selection: Omit<SelectedModel, "revision" | "updatedAt"> = { id: "local/fixture", providerId: "local", wireId: discovered.wireId,
      displayName: discovered.displayName, type: discovered.type, contextWindow: discovered.contextWindow, maxTokens: discovered.maxTokens,
      capabilities: discovered.capabilities, pricing: discovered.pricing, enabled: true, operations: ["chat/completions"] };
    const selected = await management.saveModel(admin, selection, null);
    assert.equal((await management.models(member))[0]?.providerRevision, updated.revision, "selected metadata carries the current provider binding revision");
    const binding=(await management.models(member))[0]!.binding;
    assert.match(binding,/^[a-f0-9]{64}$/);
    assert.ok(!binding.includes(configuration.baseUrl),"the binding never exposes the provider address");
    await assert.rejects(management.saveModel(admin, { ...selection, id: "local/duplicate" }, null), { code: "model_already_selected" });
    const admission = (id: string, actor = member): Admission => ({ requestId: id, modelId: selection.id, principal: actor,
      operation: "chat/completions", executionId: `execution-${id}`, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    for(const expectedRevision of [{model:selected.revision+1,provider:updated.revision},{model:selected.revision,provider:provider.revision}]) {
      await assert.rejects(repository.admit({...admission("stale-binding"),expectedRevision},8),{code:"binding_changed"});
    }
    assert.equal(await repository.getUsage(member.service,"stale-binding"),null,"stale metadata cannot create an intent or dispatch");
    await assert.rejects(repository.admit({...admission("wrong-binding"),expectedBinding:"0".repeat(64)},8),{code:"binding_changed"});
    assert.equal(await repository.getUsage(member.service,"wrong-binding"),null);
    const originalProvider=(await pool.query("SELECT configuration FROM agent_models_providers WHERE id='local'")).rows[0].configuration;
    try {
      await pool.query("UPDATE agent_models_providers SET configuration=jsonb_set(configuration,'{baseUrl}',to_jsonb($1::text)) WHERE id='local'",["https://restored.example.test/v1"]);
      const restored=(await management.models(member))[0]!;
      assert.equal(restored.providerRevision,updated.revision);
      assert.notEqual(restored.binding,binding,"an equivalent revision counter cannot hide a different restored connection");
      await assert.rejects(repository.admit({...admission("restored-binding"),expectedBinding:binding,expectedRevision:{model:selected.revision,provider:updated.revision}},8),{code:"binding_changed"});
    } finally {await pool.query("UPDATE agent_models_providers SET configuration=$1 WHERE id='local'",[originalProvider]);}
    const simultaneous = await Promise.allSettled(Array.from({ length: 8 }, () => repository.admit(admission("single"), 8)));
    assert.equal(simultaneous.filter(result => result.status === "fulfilled").length, 1, "concurrent duplicate calls have one durable dispatch intent");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_models_requests")).rows[0].n, 1);
    const receipt: Settlement = { outcome: "succeeded", measurement: "reported", amounts: { inputTokens: 1000, outputTokens: 100 },
      costUsd: 0.0026, costSource: "calculated", httpStatus: 200, errorCode: null, responseBytes: 42, durationMs: 12 };
    await Promise.all([repository.settle(member.service, "single", "execution-single", receipt), repository.settle(member.service, "single", "execution-single", receipt)]);
    await assert.rejects(repository.settle(member.service, "single", "execution-single", { ...receipt, costUsd: 100 }), { code: "settlement_conflict" });
    await management.saveModel(admin, { ...selection, pricing: { inputPer1M: 100, outputPer1M: 200 } }, selected.revision);
    assert.deepEqual((await repository.getUsage(member.service, "single"))?.pricing, selection.pricing, "past usage keeps its original pricing snapshot");
    const limited = await Promise.allSettled([repository.admit(admission("capacity-a"), 1), repository.admit(admission("capacity-b"), 1)]);
    assert.equal(limited.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(limited.filter(result => result.status === "rejected" && result.reason.code === "capacity_exceeded").length, 1);
    await pool.query("UPDATE agent_models_requests SET deadline_at=now()-interval '1 second' WHERE state='running'");
    assert.equal(await repository.expire(), 1);
    const expired = (await pool.query("SELECT request_id,cost_usd,settlement FROM agent_models_requests WHERE state='unknown'")).rows[0];
    assert.equal(expired.cost_usd, null);
    assert.equal(expired.settlement.measurement, "unavailable");
    await assert.rejects(repository.admit(admission(expired.request_id), 1), { code: "request_already_exists" });
    await assert.rejects(repository.settle(member.service, expired.request_id, "wrong-execution", receipt), { code: "settlement_conflict" });
    await repository.settle(member.service, expired.request_id, `execution-${expired.request_id}`, receipt);
    assert.equal((await repository.getUsage(member.service, expired.request_id))?.state, "succeeded", "late authoritative settlement can reconcile an expired request");
    await management.saveProvider(admin, { ...configuration, enabled: false }, updated.revision);
    assert.deepEqual(await management.models(member), []);
    await assert.rejects(repository.admit(admission("disabled"), 1), { code: "model_disabled" });
    const disabledProvider = await repository.getProvider("local");
    await management.saveProvider(admin, configuration, disabledProvider!.revision);
    assert.notEqual((await management.models(member))[0]?.providerRevision, updated.revision, "a provider update changes consumer cache identity without exposing its connection");
    let calls = 0;
    const inference = createInference({ repository, cipher, timeoutMs: 60_000, concurrencyLimit: 8, executionId: () => randomUUID(), now: Date.now, monotonic: () => performance.now(),
      transport: { async execute(input) {
        calls++;
        input.onDispatch();
        assert.equal(input.secret, "fixture-provider-key");
        let complete = false;
        return { status: 200, headers: { "content-type": "text/event-stream" },
          body: (async function* () { yield new TextEncoder().encode("data: fixture\n\n"); complete = true; })(),
          observation: () => ({ amounts: { inputTokens: 1000, outputTokens: 100 }, measurement: "reported", complete, errorCode: null }) };
      } } });
    const invoke = (id: string, actor: Principal = member) => inference(actor, { requestId: id, modelId: selection.id, operation: "chat/completions",
      body: { kind: "json", value: { messages: [] } }, signal: new AbortController().signal });
    await assert.rejects(invoke("guest", { ...member, canInvoke: false }), { code: "execution_forbidden" });
    const authorized: Principal = { ...member, modelCall: { version: 1, requestId: "inference", modelId: selection.id, operation: "chat/completions", agentId: member.agentId! } };
    await assert.rejects(invoke("different", authorized), { code: "invocation_grant_mismatch" });
    await assert.rejects(invoke("inference", { ...authorized, modelCall: { ...authorized.modelCall!, modelId: "other" } }), { code: "invocation_grant_mismatch" });
    await assert.rejects(invoke("inference", { ...authorized, modelCall: { ...authorized.modelCall!, operation: "responses" } }), { code: "invocation_grant_mismatch" });
    assert.equal(calls, 0, "a mismatched invocation cannot dispatch or spend capacity");
    const response = await invoke("inference", authorized);
    for await (const _ of response.body) { /* Draining is the observable response lifecycle. */ }
    assert.equal(calls, 1);
    assert.equal((await repository.getUsage(member.service, "inference"))?.settlement?.costUsd, 0.12);
    await assert.rejects(invoke("inference"), { code: "request_already_exists" });
    assert.equal(calls, 1, "repeated request never reaches the provider");
    const cancelled = await invoke("cancelled");
    const iterator = cancelled.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    const cancelledUsage = await repository.getUsage(member.service, "cancelled");
    assert.equal(cancelledUsage?.state, "cancelled");
    assert.equal(cancelledUsage.settlement?.measurement, "partial");
    assert.equal(cancelledUsage.settlement?.costUsd, null);
    const systemResponse = await invoke("system", { ...admin, kind: "service", subject: "service:agent-memory", service: "agent-memory" });
    for await (const _ of systemResponse.body) { /* Account for the system job separately. */ }
    const query = { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString(), groupBy: "user" as const, limit: 100 };
    assert.equal((await management.requestUsage(authorized, member.service, "inference")).agentId, member.agentId);
    await assert.rejects(management.requestUsage(authorized, member.service, "single"), { code: "request_not_found" });
    assert.throws(() => management.usageOverview(authorized, query), { code: "invocation_grant_only" });
    const receiptService: Principal = { kind: "service", subject: "service:agent-studio", service: member.service, admin: false, canInvoke: false, serviceReceipts: true };
    assert.equal((await management.requestUsage(receiptService, member.service, "inference")).subject, member.subject);
    await assert.rejects(management.requestUsage({ ...receiptService, service: "agent-memory" }, member.service, "inference"), { code: "request_not_found" });
    await assert.rejects(management.requestUsage({ ...receiptService, serviceReceipts: false }, member.service, "inference"), { code: "request_not_found" });
    await assert.rejects(management.requestUsage({ ...member, kind: "service" }, member.service, "inference"), { code: "request_not_found" });
    assert.deepEqual(await management.usage({ ...member, kind: "service" }, query), [], "equal subject strings cannot mix user and service usage");
    const mine = await management.usage(member, { ...query, subject: "service:agent-memory" });
    assert.deepEqual(mine.map(row => row.key), [member.subject]);
    assert.equal(mine[0]!.requests, 4);
    assert.equal(mine[0]!.cancelled, 1);
    assert.equal(mine[0]!.unpriced, 1);
    assert.deepEqual(mine[0]!.usage.inputTokens, { total: 4000, observedRequests: 4 });
    assert.equal(mine[0]!.usage.images, undefined, "an absent usage axis is not a measured zero");
    const all = await management.usage(admin, query);
    assert.equal(all.length, 2);
    const overview = await management.usageOverview(admin, { ...query, limit: 1, after: "member" });
    assert.equal(overview.groups.length, 1);
    assert.equal(overview.totals.requests, 5, "period totals are independent of group pagination");
    assert.deepEqual((await management.usage(admin, { ...query, after: "member" })).map(row => row.key), ["service:agent-memory"]);
    await assert.rejects(management.requestUsage(member, "agent-memory", "system"), { code: "request_not_found" });
    assert.equal((await pool.query("SELECT id FROM agent_studio_fixture")).rows[0].id, "preserved");
    console.log("PASS Models PostgreSQL: schema/sibling safety, encrypted credentials, explicit selection, optimistic concurrency, idempotent admission/settlement, capacity, expiry/recovery, cancellation, price snapshots and actor-scoped usage");
    await checkProviderHttp(repository, cipher);
  } finally {
    await pool.end();
    await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.end();
  }
}

await check();
