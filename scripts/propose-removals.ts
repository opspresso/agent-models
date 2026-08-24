/** Turn lifecycle-qualified hidden offerings into an explicit removal proposal. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatJson, loadRegistry, writeRegistry, writeTextAtomic } from "../src/registry.ts";
import {
  applyRemovalCandidates,
  loadRemovalManifest,
  type RemovalCandidate,
} from "../src/removals.ts";
import { REPORT_PATH, ROOT } from "./_root.ts";

const report = JSON.parse(readFileSync(REPORT_PATH, "utf-8")) as {
  date: string;
  removalCandidates?: RemovalCandidate[];
};
const candidates = report.removalCandidates ?? [];
if (candidates.length === 0) {
  console.log("no lifecycle-qualified model removals to propose");
  process.exit(0);
}

const proposal = applyRemovalCandidates(
  loadRegistry(ROOT),
  candidates,
  loadRemovalManifest(ROOT),
  report.date,
);
writeRegistry(ROOT, proposal.registry);
writeTextAtomic(join(ROOT, "models", "removals.json"), formatJson(proposal.requests));
console.log(`proposed model removal(s): ${candidates.map(({ id }) => id).join(", ")}`);
