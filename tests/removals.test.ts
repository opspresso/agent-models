import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertRemovalPolicy, loadRemovalManifest, unapprovedRemovals } from "../src/removals.ts";

describe("removal manifest", () => {
  it("allows only exact approved published ids", () => {
    const approvals = [{ id: "openrouter/old", reason: "The id was never publicly usable", approvedAt: "2026-08-23" }];
    assert.deepEqual(unapprovedRemovals(["openrouter/old", "openai/live"], ["openai/live"], approvals), []);
    assert.deepEqual(unapprovedRemovals(["openrouter/other"], [], approvals), ["openrouter/other"]);
  });

  it("allows permanent removal only in a pull request", () => {
    const approvals = [{ id: "openrouter/old", reason: "retired permanently", approvedAt: "2026-08-23" }];
    assert.throws(
      () => assertRemovalPolicy(["openrouter/old"], [], approvals, false),
      /allowed only through a pull request/,
    );
    assert.doesNotThrow(() => assertRemovalPolicy(["openrouter/old"], [], approvals, true));
    assert.throws(() => assertRemovalPolicy(["openrouter/other"], [], approvals, true), /unapproved/);
    assert.doesNotThrow(() => assertRemovalPolicy(["openrouter/live"], ["openrouter/live"], [], false));
  });

  it("rejects malformed and duplicate approvals", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-models-removals-"));
    mkdirSync(join(root, "models"));
    try {
      writeFileSync(join(root, "models/removals.json"), JSON.stringify([
        { id: "openrouter/old", reason: "approved", approvedAt: "2026-08-23" },
        { id: "openrouter/old", reason: "again", approvedAt: "2026-08-23" },
      ]));
      assert.throws(() => loadRemovalManifest(root), /repeats/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
