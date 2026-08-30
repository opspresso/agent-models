/**
 * The registry: what a model is, who serves it, and the catalog derived from
 * the two.
 *
 * A **family** states a model once — display name, price, window, what it can
 * do. An **offering** says a provider serves that family, under which wire
 * name, and what the route changes about it. The published catalog
 * (`docs/models.json`) is the pair resolved into one flat list, because a
 * consumer wants "the models" and not the bookkeeping that keeps three routes
 * to one model from drifting apart.
 *
 * Source files live under `models/`:
 *
 *   models/providers.json          the routes a model id may be prefixed with
 *   models/makers.json             maker id → display name and source metadata
 *   models/families/<maker>.json   { "<family>": ModelFamily } — the file is the maker
 *   models/offerings/<provider>.json [ModelOffering] — the file is the provider
 *
 * Every shape here mirrors `src/domain/llm/models.ts` in Agent Studio, which is
 * the consumer the catalog exists for; a field is added here only when that
 * registry can read it.
 */

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

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** USD per million tokens unless the name says otherwise. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  /** Image-token rates for image-generation models. */
  imageInputPer1M?: number;
  imageOutputPer1M?: number;
  /**
   * Flat per-image price. Authoritative for models with no token-based image
   * output rate (`imageOutputPer1M` absent/0); informational otherwise.
   */
  perImage?: number;
  /** Flat charge for each source image supplied to an image edit. */
  perInputImage?: number;
  /**
   * A promotional discount, as a fraction in (0, 1), that the rates above are
   * *already net of* — so a reader can tell a promotion from a price and put
   * the list rate back (`inputPer1M / (1 - discount)`). Carried only where a
   * source publishes it (OpenRouter, per endpoint); absent means no discount
   * is known, not that there is none.
   */
  discount?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  reasoning: boolean;
  imageGeneration?: boolean;
  /**
   * False when the provider rejects `tools` together with `reasoning_effort`
   * on chat/completions. Absent means the combination is allowed.
   */
  reasoningWithTools?: boolean;
}

/** What a model is, stated once and shared by every route that serves it. */
export interface ModelFamily {
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  /** Provenance a reader of the file needs — where a number came from, why an odd one is right. */
  note?: string;
}

/**
 * One route to a family. Overrides are shallow merges over the family's
 * values, so an offering names only what differs.
 */
export interface ModelOffering {
  family: string;
  /** The provider's own name for the model, when it differs from the family id. */
  wireId?: string;
  pricing?: Partial<ModelPricing>;
  capabilities?: Partial<ModelCapabilities>;
  /**
   * A route may cap the output lower than the model's own limit. There is no
   * `contextWindow` counterpart on purpose: the window identifies the model,
   * and the same model reached two ways has one.
   */
  maxTokens?: number;
  /** Hidden from a model picker but still resolvable — a retired route keeps pricing history honest. */
  hidden?: boolean;
  /**
   * `YYYY-MM-DD` the daily update first found this live route missing from its
   * provider's catalog. Cleared when it is back; turned into `hidden` after
   * the successful-observation grace (`src/sources/presence.ts`). Bookkeeping, not a fact
   * about the model — the catalog does not carry it.
   */
  missingSince?: string;
  /** Successful catalog observations in the current absence streak. */
  missingObservations?: number;
  /** Prevents retries on one UTC date from counting more than once. */
  lastMissingAt?: string;
  /** Why automation hid the route. Absent means a deliberate/manual retirement. */
  hiddenReason?: "catalog" | "ranking" | "reset";
  /** UTC date automation hid the route; permanent removal waits from this date. */
  hiddenAt?: string;
  /** First successful ranking observation on which the route was ineligible. */
  rankMissingSince?: string;
  /** Successful ranking observations in the current ineligible streak. */
  rankMissingObservations?: number;
  /** Prevents retries on one UTC date from counting more than once. */
  lastRankMissingAt?: string;
  note?: string;
}

/** An offering together with the provider its file named. */
export interface PlacedOffering extends ModelOffering {
  provider: string;
}

/** One offering resolved against its family — the catalog's unit. */
export interface ModelConfig {
  /** `provider/family`, e.g. `google/gemini-3.1-flash-lite`. */
  id: string;
  provider: string;
  family: string;
  maker: string;
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  wireId?: string;
  hidden?: boolean;
}

export interface ModelMaker {
  displayName: string;
  /** The vendor slug OpenRouter files this maker's models under. Absent when it has none. */
  openrouterVendor?: string;
}

export interface Registry {
  providers: string[];
  makers: Record<string, ModelMaker>;
  /** Keyed by family id; the maker is on the entry because the file it came from said so. */
  families: Record<string, ModelFamily & { maker: string }>;
  offerings: PlacedOffering[];
}

export const CATALOG_VERSION = 1;

export interface Catalog {
  version: typeof CATALOG_VERSION;
  /** When the content last changed — not when it was last checked. */
  updatedAt: string;
  source: string;
  providers: string[];
  makers: Record<string, string>;
  models: ModelConfig[];
}

export const CATALOG_SOURCE = "https://github.com/opspresso/agent-models";

// ---------------------------------------------------------------------------
// Canonical key order — what keeps a script's rewrite of a file a one-line diff
// ---------------------------------------------------------------------------

const PRICING_KEYS = [
  "inputPer1M",
  "outputPer1M",
  "cachedInputPer1M",
  "imageInputPer1M",
  "imageOutputPer1M",
  "perImage",
  "perInputImage",
  "discount",
] as const;

const CAPABILITY_KEYS = [
  "tools",
  "structuredOutput",
  "imageInput",
  "reasoning",
  "imageGeneration",
  "reasoningWithTools",
] as const;

const FAMILY_KEYS = [
  "displayName",
  "pricing",
  "capabilities",
  "contextWindow",
  "maxTokens",
  "note",
] as const;

const OFFERING_KEYS = [
  "family",
  "wireId",
  "pricing",
  "capabilities",
  "maxTokens",
  "hidden",
  "hiddenReason",
  "hiddenAt",
  "missingSince",
  "missingObservations",
  "lastMissingAt",
  "rankMissingSince",
  "rankMissingObservations",
  "lastRankMissingAt",
  "note",
] as const;

const MODEL_KEYS = [
  "id",
  "provider",
  "family",
  "maker",
  "displayName",
  "pricing",
  "capabilities",
  "contextWindow",
  "maxTokens",
  "wireId",
  "hidden",
] as const;

const MAKER_KEYS = ["displayName", "openrouterVendor"] as const;

type Plain = Record<string, unknown>;

function ordered(value: Plain, keys: readonly string[]): Plain {
  const out: Plain = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      out[key] = value[key];
    }
  }
  // Anything the order does not know goes last, alphabetically — validation
  // rejects such keys, so this only matters for an error message's diff.
  for (const key of Object.keys(value).sort()) {
    if (!keys.includes(key) && value[key] !== undefined) {
      out[key] = value[key];
    }
  }
  return out;
}

function orderedFamily(family: ModelFamily): Plain {
  const plain = family as unknown as Plain;
  return ordered(
    {
      ...plain,
      pricing: ordered(plain.pricing as Plain, PRICING_KEYS),
      capabilities: ordered(plain.capabilities as Plain, CAPABILITY_KEYS),
    },
    FAMILY_KEYS,
  );
}

function orderedOffering(offering: ModelOffering): Plain {
  const plain = offering as unknown as Plain;
  return ordered(
    {
      ...plain,
      ...(plain.pricing !== undefined ? { pricing: ordered(plain.pricing as Plain, PRICING_KEYS) } : {}),
      ...(plain.capabilities !== undefined
        ? { capabilities: ordered(plain.capabilities as Plain, CAPABILITY_KEYS) }
        : {}),
    },
    OFFERING_KEYS,
  );
}

function orderedModel(model: ModelConfig): Plain {
  const plain = model as unknown as Plain;
  return ordered(
    {
      ...plain,
      pricing: ordered(plain.pricing as Plain, PRICING_KEYS),
      capabilities: ordered(plain.capabilities as Plain, CAPABILITY_KEYS),
    },
    MODEL_KEYS,
  );
}

function orderedMaker(maker: ModelMaker): Plain {
  return ordered(maker as unknown as Plain, MAKER_KEYS);
}

/** Two-space JSON with a trailing newline — the one format every file here is written in. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Loading and writing the source files
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
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
  const providers = readJson(join(base, "providers.json")) as string[];
  const makers = readJson(join(base, "makers.json")) as Record<string, ModelMaker>;

  const families: Registry["families"] = {};
  for (const file of listJson(join(base, "families"))) {
    const maker = basename(file, ".json");
    const entries = readJson(file) as Record<string, ModelFamily>;
    for (const [id, family] of Object.entries(entries)) {
      if (families[id] !== undefined) {
        throw new Error(`family "${id}" is defined twice (second in ${file})`);
      }
      families[id] = { ...family, maker };
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
    const entries = readJson(file) as ModelOffering[];
    for (const offering of entries) {
      offerings.push({ ...offering, provider });
    }
  }

  return { providers, makers, families, offerings };
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
        renameSync(backup, base);
      }
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(transaction, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** One offering resolved against its family. Overrides are shallow merges. */
export function deriveModel(registry: Registry, offering: PlacedOffering): ModelConfig {
  const family = registry.families[offering.family];
  if (family === undefined) {
    throw new Error(`offering ${offering.provider}/${offering.family} names an unknown family`);
  }
  return {
    id: `${offering.provider}/${offering.family}`,
    provider: offering.provider,
    family: offering.family,
    maker: family.maker,
    displayName: family.displayName,
    pricing: { ...family.pricing, ...offering.pricing },
    capabilities: { ...family.capabilities, ...offering.capabilities },
    contextWindow: family.contextWindow,
    maxTokens: offering.maxTokens ?? family.maxTokens,
    ...(offering.wireId !== undefined ? { wireId: offering.wireId } : {}),
    ...(offering.hidden ? { hidden: true } : {}),
  };
}

export function deriveModels(registry: Registry): ModelConfig[] {
  return registry.offerings.map((offering) => deriveModel(registry, offering));
}

// ---------------------------------------------------------------------------
// Validation — every invariant Agent Studio's `tests/models.test.ts` holds the
// registry to, checked here before a catalog is published
// ---------------------------------------------------------------------------

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Plain, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Whether a string may be a maker, provider or family id. Exported because
 * discovery has to ask *before* it adopts a catalog's spelling: a name filed
 * anyway fails validation at the end of the run, and one unusable listing
 * would take the whole day's update with it.
 */
export function isSafeSlug(value: string): boolean {
  return value.length <= 100 && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}

function isUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function checkPricing(where: string, pricing: unknown, partial: boolean, errors: string[]): void {
  if (!isPlain(pricing)) {
    errors.push(`${where}: pricing is not an object`);
    return;
  }
  for (const key of unknownKeys(pricing, PRICING_KEYS)) {
    errors.push(`${where}: unknown pricing field "${key}"`);
  }
  for (const key of PRICING_KEYS) {
    const value = pricing[key];
    const required = !partial && (key === "inputPer1M" || key === "outputPer1M");
    if (value === undefined) {
      if (required) {
        errors.push(`${where}: pricing.${key} is required`);
      }
      continue;
    }
    if (key === "discount") {
      if (typeof value !== "number" || !(value > 0 && value < 1)) {
        errors.push(`${where}: pricing.discount must be a fraction in (0, 1)`);
      }
      continue;
    }
    if (!isPrice(value)) {
      errors.push(`${where}: pricing.${key} must be a non-negative number`);
    }
  }
}

function checkCapabilities(
  where: string,
  capabilities: unknown,
  partial: boolean,
  errors: string[],
): void {
  if (!isPlain(capabilities)) {
    errors.push(`${where}: capabilities is not an object`);
    return;
  }
  for (const key of unknownKeys(capabilities, CAPABILITY_KEYS)) {
    errors.push(`${where}: unknown capability "${key}"`);
  }
  for (const key of CAPABILITY_KEYS) {
    const value = capabilities[key];
    const required =
      !partial && (key === "tools" || key === "structuredOutput" || key === "imageInput" || key === "reasoning");
    if (value === undefined) {
      if (required) {
        errors.push(`${where}: capabilities.${key} is required`);
      }
      continue;
    }
    if (typeof value !== "boolean") {
      errors.push(`${where}: capabilities.${key} must be a boolean`);
    }
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isImageCount(value: unknown, imageGeneration: boolean): value is number {
  return isCount(value) || (imageGeneration && value === 0);
}

/** Every problem with the registry, or an empty list. Never throws on bad data — it reports it. */
export function validateRegistry(registry: Registry): string[] {
  const errors: string[] = [];

  if (!Array.isArray(registry.providers) || registry.providers.some((p) => typeof p !== "string")) {
    errors.push("providers.json must be an array of strings");
  } else {
    for (const provider of registry.providers) {
      if (!isSafeSlug(provider)) {
        errors.push(`provider id "${provider}" must be a safe slug`);
      }
    }
  }
  // Self-hosted models are published by each deployment (Agent Studio's own
  // declarations), never by this catalog: a selfhosted entry published here
  // would install in every consumer's registry and block the deployment's own
  // declarations against its catalog-collision rule.
  if (Array.isArray(registry.providers) && registry.providers.includes("selfhosted")) {
    errors.push('providers.json must not carry "selfhosted" — deployments publish those models themselves');
  }
  if (!isPlain(registry.makers)) {
    errors.push("makers.json must be an object of maker id → maker definition");
  } else {
    const vendors = new Map<string, string>();
    for (const [id, maker] of Object.entries(registry.makers)) {
      const where = `maker ${id}`;
      if (!isSafeSlug(id)) {
        errors.push(`maker id "${id}" must be a safe slug`);
      }
      if (!isPlain(maker)) {
        errors.push(`${where}: not an object`);
        continue;
      }
      for (const key of unknownKeys(maker, MAKER_KEYS)) {
        errors.push(`${where}: unknown field "${key}"`);
      }
      if (typeof maker.displayName !== "string" || maker.displayName.trim() === "") {
        errors.push(`${where}: displayName is required`);
      }
      const vendor = maker.openrouterVendor;
      if (vendor !== undefined) {
        if (typeof vendor !== "string" || vendor === "" || vendor.includes("/")) {
          errors.push(`${where}: openrouterVendor must be a bare vendor slug`);
        } else if (vendors.has(vendor)) {
          errors.push(`${where}: openrouterVendor "${vendor}" is already used by maker ${vendors.get(vendor)}`);
        } else {
          vendors.set(vendor, id);
        }
      }
    }
  }

  // Families
  for (const [id, family] of Object.entries(registry.families)) {
    const where = `family ${id}`;
    if (!isSafeSlug(id)) {
      errors.push(`${where}: id must be a safe slug`);
    }
    if (!isPlain(family)) {
      errors.push(`${where}: not an object`);
      continue;
    }
    const { maker, ...own } = family;
    if (registry.makers[maker] === undefined) {
      errors.push(`${where}: maker "${maker}" is not in makers.json`);
    }
    for (const key of unknownKeys(own as Plain, FAMILY_KEYS)) {
      errors.push(`${where}: unknown field "${key}"`);
    }
    if (typeof family.displayName !== "string" || family.displayName.trim() === "") {
      errors.push(`${where}: displayName is required`);
    }
    checkPricing(where, family.pricing, false, errors);
    checkCapabilities(where, family.capabilities, false, errors);
    const imageGeneration = family.capabilities?.imageGeneration === true;
    if (!isImageCount(family.contextWindow, imageGeneration)) {
      errors.push(`${where}: contextWindow must be a positive integer, or zero for an image model`);
    }
    if (!isImageCount(family.maxTokens, imageGeneration)) {
      errors.push(`${where}: maxTokens must be a positive integer, or zero for an image model`);
    }
    if (family.note !== undefined && typeof family.note !== "string") {
      errors.push(`${where}: note must be a string`);
    }
  }

  // Offerings
  const seen = new Set<string>();
  for (const offering of registry.offerings) {
    const id = `${offering.provider}/${offering.family}`;
    const where = `offering ${id}`;
    if (!registry.providers.includes(offering.provider)) {
      errors.push(`${where}: provider "${offering.provider}" is not in providers.json`);
    }
    if (seen.has(id)) {
      errors.push(`${where}: duplicate offering`);
    }
    seen.add(id);
    const { provider: _provider, ...own } = offering;
    for (const key of unknownKeys(own as Plain, OFFERING_KEYS)) {
      errors.push(`${where}: unknown field "${key}"`);
    }
    const family = registry.families[offering.family];
    if (family === undefined) {
      errors.push(`${where}: unknown family "${offering.family}"`);
      continue;
    }
    if (offering.pricing !== undefined) {
      checkPricing(where, offering.pricing, true, errors);
    }
    if (offering.capabilities !== undefined) {
      checkCapabilities(where, offering.capabilities, true, errors);
      // A route may not disagree with its family about what kind of model it is.
      if (
        offering.capabilities.imageGeneration !== undefined &&
        offering.capabilities.imageGeneration !== (family.capabilities.imageGeneration ?? false)
      ) {
        errors.push(`${where}: a route may not change imageGeneration`);
      }
    }
    if (offering.maxTokens !== undefined && !isCount(offering.maxTokens)) {
      errors.push(`${where}: maxTokens must be a positive integer`);
    }
    if (offering.hidden !== undefined && offering.hidden !== true) {
      errors.push(`${where}: hidden is either true or absent`);
    }
    if (offering.hiddenReason !== undefined) {
      if (!offering.hidden || !["catalog", "ranking", "reset"].includes(offering.hiddenReason)) {
        errors.push(`${where}: hiddenReason requires hidden and must be catalog, ranking, or reset`);
      }
    }
    if (offering.hiddenAt !== undefined) {
      if (!isUtcDate(offering.hiddenAt)) {
        errors.push(`${where}: hiddenAt must be a valid UTC date in YYYY-MM-DD form`);
      }
      if (!offering.hidden || !["catalog", "ranking"].includes(offering.hiddenReason ?? "")) {
        errors.push(`${where}: hiddenAt requires an automatically hidden catalog or ranking route`);
      }
    }
    if (offering.missingSince !== undefined) {
      if (!isUtcDate(offering.missingSince)) {
        errors.push(`${where}: missingSince must be a valid UTC date in YYYY-MM-DD form`);
      }
      if (offering.hidden && offering.hiddenReason !== "catalog") {
        errors.push(`${where}: a hidden route is not watched — drop missingSince`);
      }
    }
    for (const field of ["lastMissingAt", "rankMissingSince", "lastRankMissingAt"] as const) {
      if (offering[field] !== undefined && !isUtcDate(offering[field])) {
        errors.push(`${where}: ${field} must be a valid UTC date in YYYY-MM-DD form`);
      }
    }
    for (const field of ["missingObservations", "rankMissingObservations"] as const) {
      if (offering[field] !== undefined && !isCount(offering[field])) {
        errors.push(`${where}: ${field} must be a positive integer`);
      }
    }
    if ((offering.missingObservations === undefined) !== (offering.missingSince === undefined)) {
      errors.push(`${where}: missingSince and missingObservations must be carried together`);
    }
    if ((offering.rankMissingObservations === undefined) !== (offering.rankMissingSince === undefined)) {
      errors.push(`${where}: rankMissingSince and rankMissingObservations must be carried together`);
    }
    if (offering.note !== undefined && typeof offering.note !== "string") {
      errors.push(`${where}: note must be a string`);
    }
    if (offering.wireId !== undefined) {
      const bare = offering.family;
      if (typeof offering.wireId !== "string" || offering.wireId.trim() === "") {
        errors.push(`${where}: empty wireId`);
      } else if (offering.wireId.startsWith(`${offering.provider}/`)) {
        errors.push(`${where}: wireId repeats its own provider prefix`);
      } else if (offering.wireId === bare) {
        errors.push(`${where}: wireId repeats the bare id — drop it`);
      }
    }
    // A router names models `vendor/model`; its wire id is the only place the vendor appears.
    if (offering.provider === "openrouter") {
      if (offering.wireId === undefined) {
        errors.push(`${where}: a router route needs a wireId`);
      } else if (!offering.wireId.includes("/")) {
        errors.push(`${where}: router wireId names no vendor`);
      }
    }
    // Anthropic serves hyphenated names and 404s on the dotted form the registry uses.
    if (offering.provider === "anthropic" && offering.family.includes(".")) {
      const expected = offering.family.replaceAll(".", "-");
      if (offering.wireId !== expected) {
        errors.push(`${where}: a dotted Anthropic id needs wireId "${expected}"`);
      }
    }
  }

  if (errors.length > 0) {
    return errors;
  }

  // Derived invariants — only meaningful once the shapes above hold.
  for (const model of deriveModels(registry)) {
    const where = `model ${model.id}`;
    if (model.maxTokens > model.contextWindow) {
      errors.push(`${where}: maxTokens exceeds contextWindow`);
    }
    const { pricing, capabilities } = model;
    if (capabilities.imageGeneration) {
      if (!((pricing.imageOutputPer1M ?? 0) > 0 || (pricing.perImage ?? 0) > 0)) {
        errors.push(`${where}: an image model needs imageOutputPer1M or perImage`);
      }
    } else if (!(pricing.inputPer1M > 0 && pricing.outputPer1M > 0)) {
      errors.push(`${where}: a text model needs input and output prices above zero`);
    }
    if (pricing.cachedInputPer1M !== undefined && pricing.cachedInputPer1M > pricing.inputPer1M) {
      errors.push(`${where}: cached input priced above uncached`);
    }
  }

  // An unrouted family is a dead entry — nothing can reach it, so nothing prices by it.
  const routed = new Set(registry.offerings.map((o) => o.family));
  for (const id of Object.keys(registry.families)) {
    if (!routed.has(id)) {
      errors.push(`family ${id}: no offering serves it`);
    }
  }

  return errors;
}

/** Validate or throw with every problem listed — for a script that must not write bad data. */
export function assertValid(registry: Registry): void {
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`registry is invalid:\n  - ${errors.join("\n  - ")}`);
  }
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * The published shape. `updatedAt` is carried over from `previous` when the
 * content is the same, so a daily rebuild that found nothing new writes the
 * same bytes and the commit step has nothing to commit.
 */
export function buildCatalog(registry: Registry, previous: Catalog | null, now: Date): Catalog {
  const models = deriveModels(registry).map((model) => orderedModel(model) as unknown as ModelConfig);
  const content = {
    providers: [...registry.providers],
    makers: Object.fromEntries(Object.entries(registry.makers).map(([id, maker]) => [id, maker.displayName])),
    models,
  };
  const unchanged =
    previous !== null &&
    previous.version === CATALOG_VERSION &&
    JSON.stringify({ providers: previous.providers, makers: previous.makers, models: previous.models }) ===
      JSON.stringify(content);
  return {
    version: CATALOG_VERSION,
    updatedAt: unchanged ? previous.updatedAt : now.toISOString(),
    source: CATALOG_SOURCE,
    ...content,
  };
}

/**
 * A catalog from its JSON text, or null when the text is not one.
 *
 * Every reader of a *previous* catalog uses `models[].id`, and the removal
 * tripwire compares those ids: an entry without one becomes an `undefined` in
 * the previous list, absent from the next, and is reported as a published
 * model being deleted. So the ids are checked here, not just the array around
 * them — a truncated or half-written file has to read as "not a catalog"
 * rather than as one that lost every model.
 */
export function parseCatalog(text: string): Catalog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlain(parsed) || !Array.isArray(parsed.models)) {
    return null;
  }
  if (!parsed.models.every((model) => isPlain(model) && typeof model.id === "string" && model.id !== "")) {
    return null;
  }
  return parsed as unknown as Catalog;
}

export function readCatalog(path: string): Catalog | null {
  if (!existsSync(path)) {
    return null;
  }
  return parseCatalog(readFileSync(path, "utf-8"));
}
