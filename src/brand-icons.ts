/** Import missing maker marks from Lobe Icons' published static SVG sources. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertValid, isSafeSlug, loadRegistry, writeTextAtomic, type ModelMaker } from "./registry.ts";
import { fetchJson, readTextCapped } from "./sources/types.ts";

const REPOSITORY = "lobehub/lobe-icons";
const ICON_PREFIX = "packages/static-svg/icons/";
const MAX_ICON_BYTES = 100 * 1024;

export interface LobeIconEntry {
  path: string;
  type: string;
  sha: string;
  size: number;
}

export interface BrandIconImport {
  maker: string;
  source: LobeIconEntry;
}

/** Only exact icon slugs qualify; no fuzzy match can assign another brand. */
export function findMissingBrandIcons(
  makers: Record<string, ModelMaker>,
  existing: ReadonlySet<string>,
  entries: readonly LobeIconEntry[],
  aliases: Readonly<Record<string, string>> = {},
): BrandIconImport[] {
  const available = new Map(entries
    .filter((entry) => entry.type === "blob" && entry.path.startsWith(ICON_PREFIX)
      && /^[-a-z0-9._]+\.svg$/.test(entry.path.slice(ICON_PREFIX.length)))
    .map((entry) => [entry.path.slice(ICON_PREFIX.length), entry]));
  const imports: BrandIconImport[] = [];
  for (const [maker, definition] of Object.entries(makers)) {
    if (existing.has(`${maker}.svg`)) continue;
    const normalizedName = definition.displayName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates = [aliases[maker], maker, definition.openrouterVendor, normalizedName]
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
    const source = candidates.map((candidate) => available.get(`${candidate}.svg`)).find((entry) => entry !== undefined);
    if (source !== undefined) imports.push({ maker, source });
  }
  return imports;
}

export async function syncBrandIcons(
  root: string,
  fetchFn: typeof fetch = fetch,
  token?: string,
  dryRun = false,
): Promise<{ upstreamSha: string; imported: string[] }> {
  const registry = loadRegistry(root);
  assertValid(registry);
  const directory = join(root, "docs", "icons", "brands");
  const aliasesPath = join(directory, "aliases.json");
  const aliases: Record<string, string> = existsSync(aliasesPath)
    ? JSON.parse(readFileSync(aliasesPath, "utf8")) as Record<string, string>
    : {};
  if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)
    || Object.entries(aliases).some(([maker, slug]) => !Object.hasOwn(registry.makers, maker) || typeof slug !== "string" || !isSafeSlug(slug))) {
    throw new Error("docs/icons/brands/aliases.json must map known makers to safe Lobe icon slugs");
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-models",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = (path: string) => fetchJson(`https://api.github.com/repos/${REPOSITORY}${path}`, { headers }, fetchFn);

  const repository = await api("") as { default_branch?: unknown };
  if (typeof repository.default_branch !== "string" || repository.default_branch === "") {
    throw new Error("Lobe Icons has no default branch");
  }
  const commit = await api(`/commits/${encodeURIComponent(repository.default_branch)}`) as { sha?: unknown };
  if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new Error("Lobe Icons has no valid commit SHA");
  }
  const tree = await api(`/git/trees/${commit.sha}?recursive=1`) as { tree?: unknown; truncated?: unknown };
  if (tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error("Lobe Icons tree is incomplete");
  }
  const imports = findMissingBrandIcons(registry.makers, new Set(readdirSync(directory)), tree.tree as LobeIconEntry[], aliases);
  const downloaded = await Promise.all(imports.map(async ({ maker, source }) => {
    if (!Number.isInteger(source.size) || source.size < 1 || source.size > MAX_ICON_BYTES
      || !/^[0-9a-f]{40}$/.test(source.sha)) {
      throw new Error(`Lobe Icons ${source.path} has invalid blob metadata`);
    }
    const url = `https://raw.githubusercontent.com/${REPOSITORY}/${commit.sha}/${source.path}`;
    const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
    const svg = await readTextCapped(response, url);
    const bytes = Buffer.from(svg, "utf8");
    if (bytes.length !== source.size || bytes.length > MAX_ICON_BYTES
      || !/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg)
      || /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|javascript:)/i.test(svg)) {
      throw new Error(`Lobe Icons ${source.path} is not a safe SVG`);
    }
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== source.sha) throw new Error(`Lobe Icons ${source.path} does not match its Git blob`);
    return { maker, svg };
  }));
  if (!dryRun) {
    for (const { maker, svg } of downloaded) writeTextAtomic(join(directory, `${maker}.svg`), svg);
  }
  return { upstreamSha: commit.sha, imported: downloaded.map(({ maker }) => maker) };
}
