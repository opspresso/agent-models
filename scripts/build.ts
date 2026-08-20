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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { assertValid, buildCatalog, formatJson, loadRegistry, readCatalog } from "../src/registry.ts";
import { CATALOG_PATH, ROOT } from "./_root.ts";

const check = process.argv.includes("--check");

const registry = loadRegistry(ROOT);
assertValid(registry);

const previous = readCatalog(CATALOG_PATH);
const catalog = buildCatalog(registry, previous, new Date());

// The automation only ever hides; deleting a family is a person's edit, and a
// published id that vanishes re-prices every consumer's past usage of it at
// $0. README: "an entry is deleted only when nothing can ever have referred
// to it" — so a build that drops a published id fails unless the removal is
// stated on purpose: ALLOW_MODEL_REMOVALS=1 node scripts/build.ts
if (previous !== null && process.env.ALLOW_MODEL_REMOVALS !== "1") {
  const next = new Set(catalog.models.map((model) => model.id));
  const removed = previous.models.map((model) => model.id).filter((id) => !next.has(id));
  if (removed.length > 0) {
    console.error(
      `refusing to drop published id(s): ${removed.join(", ")} — hide the offering instead, or set ALLOW_MODEL_REMOVALS=1 for a deliberate removal`,
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
  writeFileSync(CATALOG_PATH, text);
  console.log(`wrote docs/models.json (${catalog.models.length} models, updatedAt ${catalog.updatedAt})`);
}
