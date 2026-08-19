/**
 * Rewrite the source files under `models/` in canonical order — what a hand
 * edit runs before committing, so the next script-made change is a one-line
 * diff rather than a reordering. Validates afterwards and exits 1 on a problem,
 * but formats first: a misplaced key is easier to find in a tidy file.
 */

import { loadRegistry, validateRegistry, writeRegistry } from "../src/registry.ts";
import { ROOT } from "./_root.ts";

const registry = loadRegistry(ROOT);
writeRegistry(ROOT, registry);
const errors = validateRegistry(registry);
if (errors.length > 0) {
  console.error(`registry is invalid:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(`formatted ${Object.keys(registry.families).length} families, ${registry.offerings.length} offerings`);
