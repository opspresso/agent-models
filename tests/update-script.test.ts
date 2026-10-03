import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const broken of ["providers", "removals"]) {
  test(`the update reports unreadable ${broken} before fetching providers`, () => {
    const root = mkdtempSync(join(tmpdir(), "agent-models-update-"));
    try {
      for (const directory of ["src", "scripts"]) {
        cpSync(new URL(`../${directory}`, import.meta.url), join(root, directory), { recursive: true });
      }
      mkdirSync(join(root, "models"));
      writeFileSync(join(root, "models/providers.json"), broken === "providers" ? "null" : "[]");
      writeFileSync(join(root, "models/makers.json"), "{}");
      writeFileSync(join(root, "models/removals.json"), broken === "removals" ? "null" : "[]");
      const summary = join(root, "summary.md");
      const result = spawnSync(process.execPath, [join(root, "scripts/update.ts")], {
        encoding: "utf8", env: { GITHUB_STEP_SUMMARY: summary }, timeout: 10_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.ok(existsSync(join(root, "update-report.json")), result.stderr);
      const report = JSON.parse(readFileSync(join(root, "update-report.json"), "utf8"));
      assert.equal(report.outcomes.length, 1);
      assert.equal(report.outcomes[0].kind, "failed");
      assert.match(report.outcomes[0].error, new RegExp(`${broken}\\.json`));
      assert.deepEqual(report.removalCandidates, []);
      assert.match(readFileSync(summary, "utf8"), /Registry — failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
