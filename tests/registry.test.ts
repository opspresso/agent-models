import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalog,
  deriveModels,
  loadRegistry,
  validateRegistry,
  type Catalog,
  type Registry,
} from "../src/registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The committed source files — the registry this repository actually publishes. */
const registry = loadRegistry(ROOT);

describe("the committed registry", () => {
  it("is valid", () => {
    assert.deepEqual(validateRegistry(registry), []);
  });

  it("has no duplicate ids", () => {
    const ids = deriveModels(registry).map((model) => model.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("says the same thing about a model however it is reached", () => {
    const byFamily = new Map<string, ReturnType<typeof deriveModels>>();
    for (const model of deriveModels(registry)) {
      byFamily.set(model.family, [...(byFamily.get(model.family) ?? []), model]);
    }
    for (const [family, routes] of byFamily) {
      const [first] = routes;
      for (const route of routes) {
        assert.equal(route.displayName, first?.displayName, `${family}: routes disagree on the name`);
        assert.equal(route.maker, first?.maker, `${family}: routes disagree on the maker`);
        assert.equal(route.contextWindow, first?.contextWindow, `${family}: routes disagree on the window`);
        assert.equal(
          route.capabilities.imageGeneration ?? false,
          first?.capabilities.imageGeneration ?? false,
          `${family}: routes disagree on kind`,
        );
      }
    }
  });

  it("identifies the model maker independently of its route", () => {
    const models = deriveModels(registry);
    assert.equal(models.find((m) => m.id === "bedrock/gpt-oss-120b")?.maker, "openai");
    assert.equal(models.find((m) => m.id === "openrouter/claude-opus-5")?.maker, "anthropic");
  });
});

/** A small valid registry to break one thing at a time. */
function fixture(): Registry {
  return {
    providers: ["openai", "anthropic", "openrouter"],
    makers: { openai: "OpenAI", anthropic: "Anthropic" },
    openrouterVendors: { openai: "openai", anthropic: "anthropic" },
    families: {
      "gpt-x": {
        maker: "openai",
        displayName: "GPT X",
        pricing: { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: 0.1 },
        capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
        contextWindow: 1000,
        maxTokens: 100,
      },
      "claude-y.1": {
        maker: "anthropic",
        displayName: "Claude Y",
        pricing: { inputPer1M: 3, outputPer1M: 15 },
        capabilities: { tools: true, structuredOutput: false, imageInput: true, reasoning: true },
        contextWindow: 2000,
        maxTokens: 200,
      },
    },
    offerings: [
      { provider: "openai", family: "gpt-x" },
      { provider: "anthropic", family: "claude-y.1", wireId: "claude-y-1" },
      { provider: "openrouter", family: "gpt-x", wireId: "openai/gpt-x", pricing: { inputPer1M: 0.5 } },
    ],
  };
}

describe("validateRegistry", () => {
  it("accepts the fixture", () => {
    assert.deepEqual(validateRegistry(fixture()), []);
  });

  it("rejects an offering of an unknown family", () => {
    const r = fixture();
    r.offerings.push({ provider: "openai", family: "gpt-z" });
    assert.match(validateRegistry(r).join("\n"), /unknown family "gpt-z"/);
  });

  it("rejects a family no offering serves", () => {
    const r = fixture();
    r.offerings = r.offerings.filter((o) => o.family !== "claude-y.1");
    assert.match(validateRegistry(r).join("\n"), /family claude-y.1: no offering serves it/);
  });

  it("rejects an unknown maker and an unknown provider", () => {
    const r = fixture();
    r.families["gpt-x"]!.maker = "acme";
    r.offerings.push({ provider: "bedrock", family: "gpt-x" });
    const errors = validateRegistry(r).join("\n");
    assert.match(errors, /maker "acme" is not in makers.json/);
    assert.match(errors, /provider "bedrock" is not in providers.json/);
  });

  it("rejects an OpenRouter vendor mapped from a maker it does not know", () => {
    const r = fixture();
    r.openrouterVendors = { ...r.openrouterVendors, acme: "acme-ai" };
    assert.match(validateRegistry(r).join("\n"), /openrouter-vendors.json: maker "acme" is not in makers.json/);
  });

  it("rejects a duplicate offering", () => {
    const r = fixture();
    r.offerings.push({ provider: "openai", family: "gpt-x" });
    assert.match(validateRegistry(r).join("\n"), /duplicate offering/);
  });

  it("rejects a key it does not know — a typo is not a new field", () => {
    const r = fixture();
    (r.families["gpt-x"] as unknown as Record<string, unknown>).contextWindows = 1;
    (r.families["gpt-x"]!.pricing as unknown as Record<string, unknown>).inputPerM = 1;
    (r.families["gpt-x"]!.capabilities as unknown as Record<string, unknown>).vision = true;
    const errors = validateRegistry(r).join("\n");
    assert.match(errors, /unknown field "contextWindows"/);
    assert.match(errors, /unknown pricing field "inputPerM"/);
    assert.match(errors, /unknown capability "vision"/);
  });

  it("requires a router route to carry a vendor-qualified wireId", () => {
    const r = fixture();
    r.offerings[2]!.wireId = "gpt-x";
    assert.match(validateRegistry(r).join("\n"), /router wireId names no vendor/);
    delete r.offerings[2]!.wireId;
    assert.match(validateRegistry(r).join("\n"), /router route needs a wireId/);
  });

  it("requires a dotted Anthropic id to carry the hyphenated wire id", () => {
    const r = fixture();
    delete r.offerings[1]!.wireId;
    assert.match(validateRegistry(r).join("\n"), /needs wireId "claude-y-1"/);
  });

  it("rejects a wireId that repeats the bare id or its own provider", () => {
    const r = fixture();
    r.offerings[0]!.wireId = "gpt-x";
    assert.match(validateRegistry(r).join("\n"), /repeats the bare id/);
    r.offerings[0]!.wireId = "openai/gpt-x";
    assert.match(validateRegistry(r).join("\n"), /repeats its own provider prefix/);
  });

  it("keeps the output cap within the window", () => {
    const r = fixture();
    r.families["gpt-x"]!.maxTokens = 5000;
    assert.match(validateRegistry(r).join("\n"), /maxTokens exceeds contextWindow/);
  });

  it("prices every text model on both sides and never caches above uncached", () => {
    const r = fixture();
    r.families["gpt-x"]!.pricing = { inputPer1M: 0, outputPer1M: 2 };
    assert.match(validateRegistry(r).join("\n"), /input and output prices above zero/);
    r.families["gpt-x"]!.pricing = { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: 3 };
    assert.match(validateRegistry(r).join("\n"), /cached input priced above uncached/);
  });

  it("prices an image model by token rate or per image", () => {
    const r = fixture();
    r.families["draw"] = {
      maker: "openai",
      displayName: "Draw",
      pricing: { inputPer1M: 0, outputPer1M: 0 },
      capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, imageGeneration: true },
      contextWindow: 100,
      maxTokens: 10,
    };
    r.offerings.push({ provider: "openai", family: "draw" });
    assert.match(validateRegistry(r).join("\n"), /image model needs imageOutputPer1M or perImage/);
    r.families["draw"]!.pricing = { inputPer1M: 0, outputPer1M: 0, perImage: 0.02 };
    assert.deepEqual(validateRegistry(r), []);
  });

  it("does not let a route change what kind of model it is", () => {
    const r = fixture();
    r.offerings[2]!.capabilities = { imageGeneration: true };
    assert.match(validateRegistry(r).join("\n"), /may not change imageGeneration/);
  });
});

describe("deriveModels", () => {
  it("merges the route over the family and names the maker from the family", () => {
    const [openai, anthropic, router] = deriveModels(fixture());
    assert.deepEqual(openai, {
      id: "openai/gpt-x",
      provider: "openai",
      family: "gpt-x",
      maker: "openai",
      displayName: "GPT X",
      pricing: { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: 0.1 },
      capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
      contextWindow: 1000,
      maxTokens: 100,
    });
    assert.equal(anthropic?.wireId, "claude-y-1");
    assert.equal(router?.pricing.inputPer1M, 0.5);
    assert.equal(router?.pricing.outputPer1M, 2);
    assert.equal(router?.maker, "openai");
  });
});

describe("buildCatalog", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const later = new Date("2026-08-21T00:00:00.000Z");

  it("stamps a fresh catalog with now", () => {
    const catalog = buildCatalog(fixture(), null, now);
    assert.equal(catalog.version, 1);
    assert.equal(catalog.updatedAt, now.toISOString());
    assert.equal(catalog.models.length, 3);
    assert.deepEqual(Object.keys(catalog.models[0] as object), [
      "id", "provider", "family", "maker", "displayName", "pricing", "capabilities", "contextWindow", "maxTokens",
    ]);
  });

  it("keeps updatedAt while the content is unchanged", () => {
    const first = buildCatalog(fixture(), null, now);
    const again = buildCatalog(fixture(), first, later);
    assert.equal(again.updatedAt, now.toISOString());
    assert.deepEqual(again, first);
  });

  it("moves updatedAt when a price changes", () => {
    const first = buildCatalog(fixture(), null, now);
    const r = fixture();
    r.families["gpt-x"]!.pricing.inputPer1M = 1.5;
    const changed = buildCatalog(r, first, later);
    assert.equal(changed.updatedAt, later.toISOString());
  });

  it("ignores a previous catalog of another version", () => {
    const first = { ...buildCatalog(fixture(), null, now), version: 0 } as unknown as Catalog;
    assert.equal(buildCatalog(fixture(), first, later).updatedAt, later.toISOString());
  });
});

describe("retirement bookkeeping", () => {
  it("accepts missingSince as a date on a live route and rejects it on a hidden one", () => {
    const r = fixture();
    r.offerings[0]!.missingSince = "2026-08-20";
    assert.deepEqual(validateRegistry(r), []);
    r.offerings[0]!.missingSince = "yesterday";
    assert.match(validateRegistry(r).join("\n"), /missingSince must be a YYYY-MM-DD date/);
    r.offerings[0]!.missingSince = "2026-08-20";
    r.offerings[0]!.hidden = true;
    assert.match(validateRegistry(r).join("\n"), /hidden route is not watched/);
  });

  it("keeps missingSince out of the catalog", () => {
    const r = fixture();
    r.offerings[0]!.missingSince = "2026-08-20";
    const catalog = buildCatalog(r, null, new Date("2026-08-20T00:00:00.000Z"));
    assert.ok(!("missingSince" in (catalog.models[0] as object)));
  });

  it("accepts a discount as a fraction and nothing else", () => {
    const r = fixture();
    r.families["gpt-x"]!.pricing.discount = 0.5;
    assert.deepEqual(validateRegistry(r), []);
    r.families["gpt-x"]!.pricing.discount = 1;
    assert.match(validateRegistry(r).join("\n"), /discount must be a fraction/);
    r.families["gpt-x"]!.pricing.discount = 0;
    assert.match(validateRegistry(r).join("\n"), /discount must be a fraction/);
  });
});
