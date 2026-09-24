/** Run weekly, or locally with --dry-run to inspect available maker icons. */

import { appendFileSync } from "node:fs";
import { syncBrandIcons } from "../src/brand-icons.ts";
import { ROOT } from "./_root.ts";

const dryRun = process.argv.includes("--dry-run");
const { upstreamSha, imported } = await syncBrandIcons(
  ROOT,
  fetch,
  process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  dryRun,
);
console.log(`Lobe Icons ${upstreamSha}: ${imported.length === 0 ? "no new Lobe matches" : `${dryRun ? "available" : "imported"} ${imported.join(", ")}`}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `count=${imported.length}\nsource_sha=${upstreamSha}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Lobe Icons ${upstreamSha}: ${imported.length === 0 ? "no new maker icons" : imported.join(", ")}\n`);
}
