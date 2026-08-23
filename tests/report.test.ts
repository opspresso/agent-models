import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderReport } from "../src/report.ts";

describe("renderReport", () => {
  it("escapes provider-controlled Markdown and table content", () => {
    const report = renderReport([{
      kind: "applied",
      result: {
        source: "@source|name",
        changes: [{ target: "model|x\nrow", field: "price", from: 1, to: "`bad`" }],
        notes: ["@team\nlook"],
      },
    }], "2026-08-23");
    assert.match(report, /&#64;source\\\|name/);
    assert.match(report, /model\\\|x row/);
    assert.match(report, /&#64;team look/);
  });
});
