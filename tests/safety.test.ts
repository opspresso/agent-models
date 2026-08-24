import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anomalyDigest, detectRegistryAnomalies } from "../src/safety.ts";
import type { Registry } from "../src/registry.ts";

function fixture(): Registry {
  return {
    providers: ["openai"],
    makers: { openai: { displayName: "OpenAI" } },
    families: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`gpt-${index}`, {
      maker: "openai",
      displayName: `GPT ${index}`,
      pricing: { inputPer1M: 1, outputPer1M: 2 },
      capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: true },
      contextWindow: 1000,
      maxTokens: 100,
    }])),
    offerings: Array.from({ length: 6 }, (_, index) => ({ provider: "openai", family: `gpt-${index}` })),
  };
}

describe("detectRegistryAnomalies", () => {
  it("quarantines unit errors and provider-wide disappearances", () => {
    const before = fixture();
    const after = structuredClone(before);
    after.families["gpt-0"]!.pricing.inputPer1M = 100;
    for (const offering of after.offerings.slice(0, 3)) {
      offering.missingSince = "2026-08-23";
      offering.missingObservations = 1;
      offering.lastMissingAt = "2026-08-23";
    }
    const anomalies = detectRegistryAnomalies(before, after).join("\n");
    assert.match(anomalies, /pricing.inputPer1M changed by more than 10x/);
    assert.match(anomalies, /3 of 6 live offerings became missing at once/);
  });

  it("allows ordinary changes and reset tombstones", () => {
    const before = fixture();
    const after = structuredClone(before);
    after.families["gpt-0"]!.pricing.inputPer1M = 1.1;
    for (const offering of after.offerings) {
      offering.hidden = true;
      offering.hiddenReason = "reset";
    }
    assert.deepEqual(detectRegistryAnomalies(before, after), []);
  });

  it("quarantines any removal, an addition burst and a mass hide", () => {
    const before = fixture();

    const dropped = structuredClone(before);
    delete dropped.families["gpt-0"];
    dropped.offerings = dropped.offerings.filter((o) => o.family !== "gpt-0");
    const removals = detectRegistryAnomalies(before, dropped).join("\n");
    assert.match(removals, /1 families would be removed/);
    assert.match(removals, /1 offerings would be removed/);

    const flooded = structuredClone(before);
    for (let index = 0; index < 41; index += 1) {
      const id = `gpt-new-${index}`;
      flooded.families[id] = structuredClone(before.families["gpt-0"]!);
      flooded.offerings.push({ provider: "openai", family: id });
    }
    const burst = detectRegistryAnomalies(before, flooded).join("\n");
    assert.match(burst, /41 families would be added/);
    assert.match(burst, /41 offerings would be added/);
    // A deliberate policy rebuild says so, and only the addition limits lift.
    assert.deepEqual(detectRegistryAnomalies(before, flooded, { allowPolicyBootstrap: true }), []);

    const wide = fixture();
    const hidden = structuredClone(wide);
    for (let index = 6; index < 16; index += 1) {
      const id = `gpt-${index}`;
      wide.families[id] = structuredClone(wide.families["gpt-0"]!);
      wide.offerings.push({ provider: "openai", family: id });
      hidden.families[id] = structuredClone(hidden.families["gpt-0"]!);
      hidden.offerings.push({ provider: "openai", family: id, hidden: true, hiddenReason: "catalog" });
    }
    assert.match(detectRegistryAnomalies(wide, hidden).join("\n"), /10 offerings would become hidden at once/);
  });

  it("treats a price appearing or vanishing as an order-of-magnitude move", () => {
    const before = fixture();
    const after = structuredClone(before);
    after.families["gpt-0"]!.pricing.inputPer1M = 0;
    assert.match(
      detectRegistryAnomalies(before, after).join("\n"),
      /gpt-0 pricing.inputPer1M changed by more than 10x/,
    );
  });

  it("gives the same approval digest regardless of anomaly order", () => {
    assert.equal(anomalyDigest(["b", "a"]), anomalyDigest(["a", "b"]));
    assert.equal(anomalyDigest(["a"]).length, 12);
  });
});
