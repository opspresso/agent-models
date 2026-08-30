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
  it("quarantines provider-wide disappearances", () => {
    const before = fixture();
    const after = structuredClone(before);
    for (const offering of after.offerings.slice(0, 3)) {
      offering.missingSince = "2026-08-23";
      offering.missingObservations = 1;
      offering.lastMissingAt = "2026-08-23";
    }
    const anomalies = detectRegistryAnomalies(before, after).join("\n");
    assert.match(anomalies, /3 of 6 live offerings became missing at once/);
  });

  it("allows provider metadata changes, additions and reset tombstones", () => {
    const before = fixture();
    const after = structuredClone(before);
    after.families["gpt-0"]!.pricing.inputPer1M = 100;
    after.families["gpt-0"]!.contextWindow = 100_000;
    after.families["gpt-0"]!.maxTokens = 50_000;
    for (let index = 0; index < 41; index += 1) {
      const id = `gpt-new-${index}`;
      after.families[id] = structuredClone(before.families["gpt-0"]!);
      after.offerings.push({ provider: "openai", family: id });
    }
    for (const offering of after.offerings) {
      offering.hidden = true;
      offering.hiddenReason = "reset";
    }
    assert.deepEqual(detectRegistryAnomalies(before, after), []);
  });

  it("quarantines any removal and a mass hide", () => {
    const before = fixture();

    const dropped = structuredClone(before);
    delete dropped.families["gpt-0"];
    dropped.offerings = dropped.offerings.filter((o) => o.family !== "gpt-0");
    const removals = detectRegistryAnomalies(before, dropped).join("\n");
    assert.match(removals, /1 families would be removed/);
    assert.match(removals, /1 offerings would be removed/);

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

  it("allows ranking-qualified retirement to proceed in bulk", () => {
    const before = fixture();
    const after = structuredClone(before);
    for (const offering of after.offerings) {
      offering.hidden = true;
      offering.hiddenReason = "ranking";
      offering.hiddenAt = "2026-08-23";
    }
    assert.deepEqual(detectRegistryAnomalies(before, after), []);
  });

  it("gives the same approval digest regardless of anomaly order", () => {
    assert.equal(anomalyDigest(["b", "a"]), anomalyDigest(["a", "b"]));
    assert.equal(anomalyDigest(["a"]).length, 12);
  });
});
