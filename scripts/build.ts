/**
 * Source files → `docs/models.json`.
 *
 *   node scripts/build.ts          # write the catalog
 *   node scripts/build.ts --check  # exit 1 if the committed catalog is stale
 *
 * `updatedAt` moves only when the content does, so a rebuild over unchanged
 * sources is byte-identical — which is what lets CI check the file in and the
 * daily job commit nothing on a quiet day.
 */

import { readFileSync, existsSync } from "node:fs";
import { loadRemovalManifest, unrequestedRemovals } from "../src/removals.ts";
import { assertValid, buildCatalog, formatJson, loadRegistry, readCatalog, writeTextAtomic } from "../src/registry.ts";
import { CATALOG_PATH, ROOT } from "./_root.ts";

const check = process.argv.includes("--check");

const registry = loadRegistry(ROOT);
assertValid(registry);
const removalRequests = loadRemovalManifest(ROOT);

const previous = readCatalog(CATALOG_PATH);
const catalog = buildCatalog(registry, previous, new Date());

// The routine update only hides. Its separate deletion proposal, or a person's
// edit, can drop a published id — which re-prices every consumer's past usage
// of it at $0. A build therefore fails unless that exact removal is requested
// in models/removals.json.
if (previous === null && existsSync(CATALOG_PATH)) {
  // A corrupt or truncated docs/models.json must not read as "first publish"
  // and wave the removal tripwire through.
  console.error("docs/models.json exists but is not a readable catalog — restore it before building");
  process.exit(1);
}
if (previous !== null) {
  const removed = unrequestedRemovals(
    previous.models.map((model) => model.id),
    catalog.models.map((model) => model.id),
    removalRequests,
  );
  if (removed.length > 0) {
    console.error(
      `refusing to drop published id(s): ${removed.join(", ")} — hide the offering instead, or request exact ids in models/removals.json`,
    );
    process.exit(1);
  }
}

const text = formatJson(catalog);

if (check) {
  const current = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, "utf-8") : "";
  if (current !== text) {
    console.error("docs/models.json is stale — run `pnpm build` and commit the result");
    process.exit(1);
  }
  console.log(`docs/models.json is up to date (${catalog.models.length} models)`);
} else {
  writeTextAtomic(CATALOG_PATH, text);
  console.log(`wrote docs/models.json (${catalog.models.length} models, updatedAt ${catalog.updatedAt})`);
}
