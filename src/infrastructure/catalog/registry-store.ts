/** Atomic filesystem persistence for the versioned catalog sources. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  assertValid, formatJson, orderedFamily, orderedOffering, orderedMaker, isPlain, parseCatalog,
  type Registry, type ModelFamily, type ModelMaker, type ModelOffering, type PlacedOffering, type Catalog,
} from "../../domain/catalog/registry.ts";

type Plain = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Loading and writing the source files
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf-8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON`, { cause: error });
  }
}

function listJson(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

/** The source files under `root/models`, read as they are — `validateRegistry` judges them. */
export function loadRegistry(root: string): Registry {
  const base = join(root, "models");
  const providers = readJson(join(base, "providers.json"));
  const makers = readJson(join(base, "makers.json"));
  if (!Array.isArray(providers) || !providers.every((provider) => typeof provider === "string")) {
    throw new Error("models/providers.json must be an array of strings");
  }
  if (!isPlain(makers)) {
    throw new Error("models/makers.json must be an object");
  }

  const families: Registry["families"] = Object.create(null);
  for (const file of listJson(join(base, "families"))) {
    const maker = basename(file, ".json");
    const entries = readJson(file);
    if (!isPlain(entries)) throw new Error(`${file} must be an object of families`);
    for (const [id, family] of Object.entries(entries)) {
      if (!isPlain(family)) throw new Error(`${file}: family "${id}" must be an object`);
      if (Object.hasOwn(families, id)) {
        throw new Error(`family "${id}" is defined twice (second in ${file})`);
      }
      families[id] = { ...(family as unknown as ModelFamily), maker };
    }
  }

  // Offerings follow providers.json's order, then their file's: the catalog's
  // order is a consumer's default order, so it is stated once rather than
  // falling out of the alphabet.
  const offerings: PlacedOffering[] = [];
  const offeringFiles = listJson(join(base, "offerings"));
  const rank = (file: string): number => {
    const index = providers.indexOf(basename(file, ".json"));
    return index === -1 ? providers.length : index;
  };
  for (const file of [...offeringFiles].sort((a, b) => rank(a) - rank(b))) {
    const provider = basename(file, ".json");
    const entries = readJson(file);
    if (!Array.isArray(entries)) throw new Error(`${file} must be an array of offerings`);
    for (const [index, offering] of entries.entries()) {
      if (!isPlain(offering)) throw new Error(`${file}[${index}] must be an object`);
      offerings.push({ ...(offering as unknown as ModelOffering), provider });
    }
  }

  return { providers, makers: makers as Record<string, ModelMaker>, families, offerings };
}

/** What `writeRegistry` produces at the top of `models/`; everything else there is carried over. */
const GENERATED_FILES = new Set(["providers.json", "makers.json"]);

/**
 * Write the registry back under `root/models`, in canonical order. Files are
 * grouped the way they were loaded — families by maker, offerings by provider
 * — so a script's change lands in the file a person would have edited.
 */
export function writeRegistry(root: string, registry: Registry): void {
  assertValid(registry);
  const base = join(root, "models");
  const transaction = mkdtempSync(join(root, ".models-write-"));
  const staging = join(transaction, "models");
  const backup = join(transaction, "previous");
  try {
    mkdirSync(join(staging, "families"), { recursive: true });
    mkdirSync(join(staging, "offerings"), { recursive: true });

    writeFileSync(join(staging, "providers.json"), formatJson(registry.providers));
    writeFileSync(
      join(staging, "makers.json"),
      formatJson(
        Object.fromEntries(Object.entries(registry.makers).map(([id, maker]) => [id, orderedMaker(maker)])),
      ),
    );

    const byMaker = new Map<string, Plain>();
    for (const [id, { maker, ...family }] of Object.entries(registry.families)) {
      const group = byMaker.get(maker) ?? {};
      group[id] = orderedFamily(family);
      byMaker.set(maker, group);
    }
    for (const maker of Object.keys(registry.makers)) {
      writeFileSync(join(staging, "families", `${maker}.json`), formatJson(byMaker.get(maker) ?? {}));
    }

    const byProvider = new Map<string, Plain[]>();
    for (const { provider, ...offering } of registry.offerings) {
      const group = byProvider.get(provider) ?? [];
      group.push(orderedOffering(offering));
      byProvider.set(provider, group);
    }
    for (const provider of registry.providers) {
      writeFileSync(join(staging, "offerings", `${provider}.json`), formatJson(byProvider.get(provider) ?? []));
    }
    // The swap below replaces `models/` wholesale, which is what clears a
    // maker's or provider's file once nothing routes through it. Anything at
    // the top level this writer does not generate — removals.json today, a
    // note or a schema tomorrow — is carried across, so adding a file there is
    // not a way to lose it on the next `pnpm format`.
    for (const name of existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []) {
      if (name.isFile() && !GENERATED_FILES.has(name.name)) {
        copyFileSync(join(base, name.name), join(staging, name.name));
      }
    }

    if (existsSync(base)) {
      renameSync(base, backup);
    }
    try {
      renameSync(staging, base);
    } catch (error) {
      if (existsSync(backup)) {
        try {
          renameSync(backup, base);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `registry replacement and rollback failed; original files preserved at ${backup}`);
        }
      }
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    // A failed rollback leaves the only original copy in backup.
    if (!existsSync(backup)) rmSync(transaction, { recursive: true, force: true });
  }
}

/** Write a generated file through a same-directory rename. */
export function writeTextAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readCatalog(path: string): Catalog | null {
  if (!existsSync(path)) {
    return null;
  }
  return parseCatalog(readFileSync(path, "utf-8"));
}
