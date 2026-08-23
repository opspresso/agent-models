import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Registry } from "../src/registry.ts";
import {
  applyRemovalCandidates,
  assertRemovalPolicy,
  findRemovalCandidates,
  loadRemovalManifest,
  unrequestedRemovals,
} from "../src/removals.ts";

function fixture(): Registry {
  return {
    providers: ["openrouter"],
    makers: { openai: { displayName: "OpenAI", openrouterVendor: "openai" } },
    families: {
      old: {
        maker: "openai",
        displayName: "Old",
        pricing: { inputPer1M: 1, outputPer1M: 2 },
        capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
        contextWindow: 1000,
        maxTokens: 100,
      },
    },
    offerings: [{ provider: "openrouter", family: "old", wireId: "openai/old" }],
  };
}

describe("removal manifest", () => {
  it("allows only exact requested published ids", () => {
    const requests = [{ id: "openrouter/old", reason: "The id was never publicly usable", requestedAt: "2026-08-23" }];
    assert.deepEqual(unrequestedRemovals(["openrouter/old", "openai/live"], ["openai/live"], requests), []);
    assert.deepEqual(unrequestedRemovals(["openrouter/other"], [], requests), ["openrouter/other"]);
  });

  it("allows permanent removal only in a pull request", () => {
    const requests = [{ id: "openrouter/old", reason: "retired permanently", requestedAt: "2026-08-23" }];
    assert.throws(
      () => assertRemovalPolicy(["openrouter/old"], [], requests, false),
      /allowed only through a pull request/,
    );
    assert.doesNotThrow(() => assertRemovalPolicy(["openrouter/old"], [], requests, true));
    assert.throws(() => assertRemovalPolicy(["openrouter/other"], [], requests, true), /without a removal request/);
    assert.doesNotThrow(() => assertRemovalPolicy(["openrouter/live"], ["openrouter/live"], [], false));
  });

  it("finds unrequested lifecycle-hidden models and turns them into removal requests", () => {
    const hidden = fixture();
    Object.assign(hidden.offerings[0]!, { hidden: true, hiddenReason: "ranking" });
    const candidates = findRemovalCandidates(hidden, []);
    assert.deepEqual(candidates, [{ id: "openrouter/old", reason: "Outside the OpenRouter ranking policy after its grace period" }]);
    assert.deepEqual(findRemovalCandidates(hidden, [{ ...candidates[0]!, requestedAt: "2026-08-22" }]), []);
    hidden.offerings[0]!.hiddenReason = "reset";
    assert.deepEqual(findRemovalCandidates(hidden, []), []);
    hidden.offerings[0]!.hiddenReason = "ranking";

    const proposal = applyRemovalCandidates(hidden, candidates, [], "2026-08-23");
    assert.deepEqual(proposal.registry.offerings, []);
    assert.deepEqual(proposal.registry.families, {});
    assert.deepEqual(proposal.requests, [{ ...candidates[0]!, requestedAt: "2026-08-23" }]);
    assert.deepEqual(hidden.offerings, [{ provider: "openrouter", family: "old", wireId: "openai/old", hidden: true, hiddenReason: "ranking" }]);
  });

  it("refuses to remove a candidate that is live again", () => {
    assert.throws(
      () => applyRemovalCandidates(fixture(), [{ id: "openrouter/old", reason: "stale request" }], [], "2026-08-23"),
      /is not an automatically hidden offering/,
    );
  });

  it("rejects malformed and duplicate requests", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-models-removals-"));
    mkdirSync(join(root, "models"));
    try {
      writeFileSync(join(root, "models/removals.json"), JSON.stringify([
        { id: "openrouter/old", reason: "requested", requestedAt: "2026-08-23" },
        { id: "openrouter/old", reason: "again", requestedAt: "2026-08-23" },
      ]));
      assert.throws(() => loadRemovalManifest(root), /repeats/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
