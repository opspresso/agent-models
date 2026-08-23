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

  it("gives the same approval digest regardless of anomaly order", () => {
    assert.equal(anomalyDigest(["b", "a"]), anomalyDigest(["a", "b"]));
    assert.equal(anomalyDigest(["a"]).length, 12);
  });
});
