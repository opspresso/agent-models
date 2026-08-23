import { execFileSync } from "node:child_process";
import { assertRemovalPolicy, loadRemovalManifest } from "../src/removals.ts";
import type { Catalog } from "../src/registry.ts";
import { readCatalog } from "../src/registry.ts";
import { CATALOG_PATH, ROOT } from "./_root.ts";

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const pullRequest = arguments_.includes("--pull-request");
const base = arguments_.find((argument) => !argument.startsWith("--")) ?? "HEAD^";
let previous: Catalog;
try {
  previous = JSON.parse(execFileSync("git", ["show", `${base}:docs/models.json`], { cwd: ROOT, encoding: "utf-8" })) as Catalog;
} catch (error) {
  console.error(`cannot read docs/models.json from ${base}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const current = readCatalog(CATALOG_PATH);
if (current === null) {
  console.error("docs/models.json is not a readable catalog");
  process.exit(1);
}
try {
  assertRemovalPolicy(
    previous.models.map(({ id }) => id),
    current.models.map(({ id }) => id),
    loadRemovalManifest(ROOT),
    pullRequest,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
console.log(pullRequest ? "pull request removals match models/removals.json" : "no published models are removed");
