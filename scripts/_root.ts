import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, wherever the script is run from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_PATH = resolve(ROOT, "docs", "models.json");
/** What `update.ts` leaves for `notify.ts`; not committed (.gitignore). */
export const REPORT_PATH = resolve(ROOT, "update-report.json");
