import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, wherever the script is run from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_PATH = resolve(ROOT, "docs", "models.json");
