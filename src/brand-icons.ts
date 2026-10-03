/** Import missing maker marks from Lobe Icons' published static SVG sources. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertValid, isSafeSlug, loadRegistry, writeTextAtomic, type ModelMaker } from "./registry.ts";
import { fetchJson, readTextCapped } from "./sources/types.ts";

const REPOSITORY = "lobehub/lobe-icons";
const ICON_PREFIX = "packages/static-svg/icons/";
const MAX_ICON_BYTES = 100 * 1024;
const STATIC_SVG_TAGS = new Set([
  "svg", "title", "defs", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask",
]);
const LENGTH_ATTRIBUTES = new Set([
  "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry",
  "stroke-width", "stroke-dashoffset", "stroke-miterlimit", "opacity", "fill-opacity", "stroke-opacity",
  "offset", "stop-opacity",
]);
const NUMBER = "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?";
const LENGTH = new RegExp(`^${NUMBER}(?:%|px|em|rem|pt|pc|mm|cm|in)?$`);
const NUMBER_LIST = new RegExp(`^${NUMBER}(?:[ ,\\t\\r\\n]+${NUMBER})*$`);
const LOCAL_PAINT = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/;
const ATTRIBUTE_VALUES: Readonly<Record<string, RegExp>> = {
  id: /^[A-Za-z_][A-Za-z0-9_.-]*$/,
  d: /^[MmZzLlHhVvCcSsQqTtAaEe0-9+.,\t\r\n -]*$/,
  viewBox: NUMBER_LIST,
  points: NUMBER_LIST,
  fill: /^(?:[a-zA-Z]+|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.%+,\t\r\n -]+\)|url\(#[A-Za-z_][A-Za-z0-9_.-]*\))$/,
  "fill-rule": /^(?:nonzero|evenodd)$/,
  "clip-rule": /^(?:nonzero|evenodd)$/,
  "clip-path": LOCAL_PAINT,
  mask: LOCAL_PAINT,
  "stroke-linecap": /^(?:butt|round|square)$/,
  "stroke-linejoin": /^(?:miter|round|bevel)$/,
  "stroke-dasharray": new RegExp(`^(?:none|${NUMBER}(?:[ ,\\t\\r\\n]+${NUMBER})*)$`),
  gradientUnits: /^(?:userSpaceOnUse|objectBoundingBox)$/,
  maskUnits: /^(?:userSpaceOnUse|objectBoundingBox)$/,
  maskContentUnits: /^(?:userSpaceOnUse|objectBoundingBox)$/,
  spreadMethod: /^(?:pad|reflect|repeat)$/,
  transform: /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9.eE+,\t\r\n -]+\)[\t\r\n ]*)+$/,
  style: /^flex:none;line-height:1;?$/,
};

/** Accept the static logo subset, not arbitrary SVG/XML or CSS. Nothing is rewritten. */
export function isSafeBrandSvg(svg: string): boolean {
  // Entities and declarations can change the parser's interpretation of otherwise safe text.
  if (/[&\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(svg)) return false;
  const tokens = /<[^>]*>|[^<]+/gy;
  const stack: string[] = [];
  let rootSeen = false;
  let offset = 0;
  while (offset < svg.length) {
    const token = tokens.exec(svg);
    if (token === null) return false;
    offset = tokens.lastIndex;
    const text = token[0];
    if (!text.startsWith("<")) {
      if (stack.at(-1) !== "title" && !/^[\t\r\n ]*$/.test(text)) return false;
      continue;
    }
    const closing = /^<\/([A-Za-z][A-Za-z0-9]*)[\t\r\n ]*>$/.exec(text);
    if (closing !== null) {
      if (stack.pop() !== closing[1]) return false;
      continue;
    }
    const opening = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/.exec(text);
    if (opening === null) return false;
    const tag = opening[1]!;
    if (!STATIC_SVG_TAGS.has(tag) || stack.at(-1) === "title") return false;
    const root = stack.length === 0;
    if (root ? rootSeen || tag !== "svg" : tag === "svg") return false;
    rootSeen = true;
    const attributes = opening[2]!;
    const attribute = /[\t\r\n ]+([A-Za-z][A-Za-z0-9-]*)[\t\r\n ]*=[\t\r\n ]*(?:"([^"<]*)"|'([^'<]*)')/gy;
    const names = new Set<string>();
    let attributeOffset = 0;
    while (attributeOffset < attributes.length) {
      if (/^[\t\r\n ]*$/.test(attributes.slice(attributeOffset))) break;
      const match = attribute.exec(attributes);
      if (match === null) return false;
      attributeOffset = attribute.lastIndex;
      const name = match[1]!;
      const value = match[2] ?? match[3]!;
      if (names.has(name)) return false;
      names.add(name);
      if (name === "xmlns") {
        if (!root || value !== "http://www.w3.org/2000/svg") return false;
      } else if (LENGTH_ATTRIBUTES.has(name)) {
        if (!LENGTH.test(value)) return false;
      } else {
        const canonical = name === "stroke" || name === "stop-color" ? "fill"
          : name === "gradientTransform" ? "transform" : name;
        if (!Object.hasOwn(ATTRIBUTE_VALUES, canonical) || !ATTRIBUTE_VALUES[canonical]!.test(value)) return false;
      }
    }
    if (root && !names.has("xmlns")) return false;
    if (opening[3] !== "/") stack.push(tag);
  }
  return rootSeen && stack.length === 0;
}

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
    if (bytes.length !== source.size || bytes.length > MAX_ICON_BYTES || !isSafeBrandSvg(svg)) {
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
