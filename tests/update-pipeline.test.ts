import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueBody, slackMessage } from "../src/notify.ts";
import { renderReport } from "../src/report.ts";
import { runUpdatePipeline, type UpdateSource } from "../src/update-pipeline.ts";
import type { Registry } from "../src/registry.ts";
import { HttpError } from "../src/sources/types.ts";

const registry: Registry = { providers: [], makers: {}, families: {}, offerings: [] };

function source(name: string, order: string[]): UpdateSource {
  return {
    name,
    disabled: null,
    fetch: async () => ({
      discover: (current) => {
        order.push(`discover:${name}`);
        return { registry: current, result: { source: name, changes: [], notes: [] } };
      },
      apply: (current) => {
        order.push(`apply:${name}`);
        return { registry: current, result: { source: name, changes: [], notes: [] } };
      },
    }),
  };
}

describe("runUpdatePipeline", () => {
  it("rejects duplicate source names before any fetch", async () => {
    const order: string[] = [];
    const duplicate: UpdateSource = { name: "Same", disabled: null, fetch: async () => { order.push("fetch"); throw new Error("unexpected fetch"); } };
    await assert.rejects(runUpdatePipeline(registry, [duplicate, duplicate]), /duplicate update source "Same"/);
    assert.deepEqual(order, []);
  });

  it("skips absent or rejected vendor keys, reports why, and continues other sources quietly", async () => {
    const order: string[] = [];
    const keyed = (name: string, credentialName: string, error: HttpError): UpdateSource => ({
      name,
      credentialName,
      disabled: null,
      fetch: async () => { throw error; },
    });
    const result = await runUpdatePipeline(registry, [
      { ...source("Missing", order), disabled: "`MISSING_API_KEY` is not set", credentialName: "MISSING_API_KEY" },
      keyed("xAI", "XAI_API_KEY", new HttpError("https://example.test/xai", 401, "Unauthorized")),
      keyed("Anthropic", "ANTHROPIC_API_KEY", new HttpError("https://example.test/anthropic", 401, "Unauthorized")),
      keyed("OpenAI", "OPENAI_API_KEY", new HttpError("https://example.test/openai", 403, "Forbidden")),
      keyed("Google", "GOOGLE_API_KEY", new HttpError("https://example.test/google", 400, "Bad Request", "API_KEY_INVALID")),
      source("OpenRouter", order),
    ]);
    assert.equal(result.failed, false);
    assert.deepEqual(result.outcomes.map((outcome) => outcome.kind), ["skipped", "skipped", "skipped", "skipped", "skipped", "applied"]);
    assert.deepEqual(order, ["discover:OpenRouter", "apply:OpenRouter"]);
    const report = renderReport(result.outcomes, "2026-09-24");
    for (const name of ["MISSING_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]) {
      assert.ok(report.includes(name));
    }
    const context = { date: "2026-09-24", outcomes: result.outcomes, runUrl: "https://example.test/run" };
    assert.equal(slackMessage(context), null);
    assert.equal(issueBody(context), null);
  });

  it("keeps unrelated HTTP errors as failures", async () => {
    const keyed = (status: number, reason?: string): UpdateSource => ({
      name: String(status),
      credentialName: "GOOGLE_API_KEY",
      disabled: null,
      fetch: async () => { throw new HttpError("https://example.test/google", status, "Error", reason); },
    });
    const result = await runUpdatePipeline(registry, [keyed(400, "INVALID_ARGUMENT"), keyed(429)]);
    assert.equal(result.failed, true);
    assert.deepEqual(result.outcomes.map((outcome) => outcome.kind), ["failed", "failed"]);
  });

  it("isolates a fetch failure and applies OpenRouter last", async () => {
    const order: string[] = [];
    const broken: UpdateSource = { name: "Broken", disabled: null, fetch: async () => { throw new Error("offline"); } };
    const result = await runUpdatePipeline(registry, [source("OpenRouter", order), broken, source("Vendor", order)]);
    assert.deepEqual(order, ["discover:OpenRouter", "discover:Vendor", "apply:Vendor", "apply:OpenRouter"]);
    assert.equal(result.failed, true);
    assert.deepEqual(result.outcomes.map((outcome) => outcome.kind), ["applied", "failed", "applied"]);
  });

  it("reports a step failure without blocking another source", async () => {
    const order: string[] = [];
    const broken = source("Broken", order);
    broken.fetch = async () => ({
      discover: () => { throw new Error("bad discovery"); },
      apply: (current) => ({ registry: current, result: { source: "Broken", changes: [], notes: [] } }),
    });
    const result = await runUpdatePipeline(registry, [broken, source("Healthy", order)]);
    assert.equal(result.outcomes[0]?.kind, "failed");
    assert.equal(result.outcomes[1]?.kind, "applied");
  });
});
