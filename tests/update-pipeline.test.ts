import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runUpdatePipeline, type UpdateSource } from "../src/update-pipeline.ts";
import type { Registry } from "../src/registry.ts";

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
