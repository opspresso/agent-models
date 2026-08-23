/**
 * Rewrite the source files under `models/` in canonical order — what a hand
 * edit runs before committing, so the next script-made change is a one-line
 * diff rather than a reordering. Validates before replacing any source file.
 */

import { loadRegistry, writeRegistry } from "../src/registry.ts";
import { loadRemovalManifest } from "../src/removals.ts";
import { ROOT } from "./_root.ts";

const registry = loadRegistry(ROOT);
loadRemovalManifest(ROOT);
writeRegistry(ROOT, registry);
console.log(`formatted ${Object.keys(registry.families).length} families, ${registry.offerings.length} offerings`);
