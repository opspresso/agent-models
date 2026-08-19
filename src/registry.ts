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
 *   models/makers.json             maker id → display label
 *   models/families/<maker>.json   { "<family>": ModelFamily } — the file is the maker
 *   models/offerings/<provider>.json [ModelOffering] — the file is the provider
 *
 * Every shape here mirrors `src/domain/llm/models.ts` in Agent Studio, which is
 * the consumer the catalog exists for; a field is added here only when that
 * registry can read it.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

export interface Registry {
  providers: string[];
  makers: Record<string, string>;
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
  const makers = readJson(join(base, "makers.json")) as Record<string, string>;

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

/**
 * Write the registry back under `root/models`, in canonical order. Files are
 * grouped the way they were loaded — families by maker, offerings by provider
 * — so a script's change lands in the file a person would have edited.
 */
export function writeRegistry(root: string, registry: Registry): void {
  const base = join(root, "models");
  mkdirSync(join(base, "families"), { recursive: true });
  mkdirSync(join(base, "offerings"), { recursive: true });

  writeFileSync(join(base, "providers.json"), formatJson(registry.providers));
  writeFileSync(join(base, "makers.json"), formatJson(registry.makers));

  const byMaker = new Map<string, Plain>();
  for (const [id, { maker, ...family }] of Object.entries(registry.families)) {
    const group = byMaker.get(maker) ?? {};
    group[id] = orderedFamily(family);
    byMaker.set(maker, group);
  }
  for (const [maker, group] of byMaker) {
    writeFileSync(join(base, "families", `${maker}.json`), formatJson(group));
  }

  const byProvider = new Map<string, Plain[]>();
  for (const { provider, ...offering } of registry.offerings) {
    const group = byProvider.get(provider) ?? [];
    group.push(orderedOffering(offering));
    byProvider.set(provider, group);
  }
  for (const [provider, group] of byProvider) {
    writeFileSync(join(base, "offerings", `${provider}.json`), formatJson(group));
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

/** Every problem with the registry, or an empty list. Never throws on bad data — it reports it. */
export function validateRegistry(registry: Registry): string[] {
  const errors: string[] = [];

  if (!Array.isArray(registry.providers) || registry.providers.some((p) => typeof p !== "string")) {
    errors.push("providers.json must be an array of strings");
  }
  if (!isPlain(registry.makers)) {
    errors.push("makers.json must be an object of maker id → label");
  }

  // Families
  for (const [id, family] of Object.entries(registry.families)) {
    const where = `family ${id}`;
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
    if (!isCount(family.contextWindow)) {
      errors.push(`${where}: contextWindow must be a positive integer`);
    }
    if (!isCount(family.maxTokens)) {
      errors.push(`${where}: maxTokens must be a positive integer`);
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
    makers: { ...registry.makers },
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

export function readCatalog(path: string): Catalog | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = readJson(path);
  if (!isPlain(parsed) || !Array.isArray(parsed.models)) {
    return null;
  }
  return parsed as unknown as Catalog;
}
