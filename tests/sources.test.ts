import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlacedOffering, Registry } from "../src/registry.ts";
import { applyOpenRouter, catalogDiscount, type OpenRouterCatalog, type OpenRouterModel } from "../src/sources/openrouter.ts";
import { applyXai } from "../src/sources/xai.ts";
import { applyAnthropic, undated } from "../src/sources/anthropic.ts";
import { applyOpenAi } from "../src/sources/openai.ts";
import { daysBetween, observePresence, RETIREMENT_GRACE_DAYS } from "../src/sources/presence.ts";
import { perMillion, type Change } from "../src/sources/types.ts";

const TEXT = { tools: true, structuredOutput: true, imageInput: true, reasoning: true };
const TODAY = "2026-08-20";

function fixture(): Registry {
  return {
    providers: ["openai", "anthropic", "xai", "openrouter"],
    makers: { openai: "OpenAI", anthropic: "Anthropic", xai: "xAI", deepseek: "DeepSeek" },
    families: {
      // Vendor-served, also routed through OpenRouter.
      "gpt-x": {
        maker: "openai",
        displayName: "GPT X",
        pricing: { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 0.5 },
        capabilities: TEXT,
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      },
      // OpenRouter-only: the family is what the router serves.
      "deepseek-z": {
        maker: "deepseek",
        displayName: "DeepSeek Z",
        pricing: { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.028 },
        capabilities: { ...TEXT, imageInput: false },
        contextWindow: 1_048_576,
        maxTokens: 384_000,
      },
      "grok-q": {
        maker: "xai",
        displayName: "Grok Q",
        pricing: { inputPer1M: 2, outputPer1M: 6, cachedInputPer1M: 0.3 },
        capabilities: TEXT,
        contextWindow: 500_000,
        maxTokens: 64_000,
      },
      "grok-old": {
        maker: "xai",
        displayName: "Grok Old",
        pricing: { inputPer1M: 1, outputPer1M: 2 },
        capabilities: TEXT,
        contextWindow: 256_000,
        maxTokens: 64_000,
      },
      "grok-draw": {
        maker: "xai",
        displayName: "Grok Draw",
        pricing: { inputPer1M: 0, outputPer1M: 0, perImage: 0.02 },
        capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, imageGeneration: true },
        contextWindow: 32_768,
        maxTokens: 4_096,
      },
      "claude-y.1": {
        maker: "anthropic",
        displayName: "Claude Y",
        pricing: { inputPer1M: 3, outputPer1M: 15 },
        capabilities: TEXT,
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      "draw-1": {
        maker: "openai",
        displayName: "Draw 1",
        pricing: { inputPer1M: 5, outputPer1M: 0, imageOutputPer1M: 30 },
        capabilities: { tools: false, structuredOutput: false, imageInput: true, reasoning: false, imageGeneration: true },
        contextWindow: 400_000,
        maxTokens: 128_000,
      },
    },
    offerings: [
      { provider: "openai", family: "gpt-x" },
      { provider: "openai", family: "draw-1" },
      { provider: "xai", family: "grok-q" },
      { provider: "xai", family: "grok-old", hidden: true },
      { provider: "xai", family: "grok-draw" },
      { provider: "anthropic", family: "claude-y.1", wireId: "claude-y-1" },
      { provider: "openrouter", family: "gpt-x", wireId: "openai/gpt-x", pricing: { inputPer1M: 2.5, outputPer1M: 15, cachedInputPer1M: 0.25 } },
      { provider: "openrouter", family: "deepseek-z", wireId: "deepseek/deepseek-z", pricing: { inputPer1M: 0.0826, outputPer1M: 0.1652, cachedInputPer1M: 0.01652 } },
      { provider: "openrouter", family: "draw-1", wireId: "openai/draw-1" },
    ],
  };
}

/** An OpenRouter catalog with no endpoints read — the discount stays whatever it was. */
function orCatalog(models: OpenRouterModel[], extra: Partial<OpenRouterCatalog> = {}): OpenRouterCatalog {
  return { models, imageIds: [], endpoints: {}, ...extra };
}

const GPT_X_LISTED: OpenRouterModel = {
  id: "openai/gpt-x",
  context_length: 1_050_000,
  pricing: { prompt: "0.0000025", completion: "0.000015", input_cache_read: "0.00000025" },
};
const DEEPSEEK_Z_LISTED: OpenRouterModel = {
  id: "deepseek/deepseek-z",
  context_length: 1_048_576,
  pricing: { prompt: "0.0000000826", completion: "0.0000001652", input_cache_read: "0.00000001652" },
  top_provider: { max_completion_tokens: 384_000 },
};
/** Everything the fixture routes through OpenRouter, present and unchanged. */
function allListed(): OpenRouterCatalog {
  return orCatalog([GPT_X_LISTED, DEEPSEEK_Z_LISTED], { imageIds: ["openai/draw-1"] });
}

describe("perMillion", () => {
  it("turns a per-token string into a per-million number without float noise", () => {
    assert.equal(perMillion(Number("0.0000000826")), 0.0826);
    assert.equal(perMillion(Number("0.000005")), 5);
    assert.equal(perMillion(Number("0.00000001652")), 0.01652);
  });
});

describe("observePresence", () => {
  it("counts whole UTC days", () => {
    assert.equal(daysBetween("2026-08-20", "2026-08-27"), 7);
    assert.equal(daysBetween("2026-08-31", "2026-09-01"), 1);
  });

  it("records the first absence, counts the days, and hides after the grace period", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", note: "Kept." };
    const changes: Change[] = [];
    let notes: string[] = [];
    observePresence(offering, false, "OpenAI", "2026-08-20", changes, notes);
    assert.equal(offering.missingSince, "2026-08-20");
    assert.match(notes[0] ?? "", /hidden automatically on 2026-08-27 if still absent/);

    notes = [];
    observePresence(offering, false, "OpenAI", "2026-08-23", changes, notes);
    assert.equal(offering.missingSince, "2026-08-20");
    assert.equal(offering.hidden, undefined);
    assert.match(notes[0] ?? "", /since 2026-08-20 \(day 4 of 7\)/);

    notes = [];
    observePresence(offering, false, "OpenAI", "2026-08-27", changes, notes);
    assert.equal(offering.hidden, true);
    assert.equal(offering.missingSince, undefined);
    assert.equal(offering.note, "Kept. Hidden automatically on 2026-08-27: absent from OpenAI's catalog since 2026-08-20.");
    assert.match(notes[0] ?? "", /hidden — Hidden automatically/);
    assert.equal(RETIREMENT_GRACE_DAYS, 7);
  });

  it("clears the clock the day the model is back", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", missingSince: "2026-08-20" };
    const changes: Change[] = [];
    observePresence(offering, true, "OpenAI", "2026-08-25", changes, []);
    assert.equal(offering.missingSince, undefined);
    assert.deepEqual(changes.map((c) => [c.field, c.to]), [["missingSince", undefined]]);
  });

  it("does not watch a hidden route", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", hidden: true };
    const notes: string[] = [];
    observePresence(offering, false, "OpenAI", "2026-08-20", [], notes);
    assert.deepEqual(notes, []);
    assert.equal(offering.missingSince, undefined);
  });
});

describe("catalogDiscount", () => {
  const listed = GPT_X_LISTED;
  it("reads the discount of the endpoint the catalog price is quoting", () => {
    const endpoints = [
      { tag: "openai", pricing: { prompt: "0.0000025", completion: "0.000015", discount: 0.5 } },
      { tag: "azure", pricing: { prompt: "0.000005", completion: "0.00003", discount: 0 } },
    ];
    assert.equal(catalogDiscount(listed, endpoints), 0.5);
  });
  it("answers null when no endpoint at that price carries one, and undefined when unread", () => {
    assert.equal(catalogDiscount(listed, [{ pricing: { prompt: "0.0000025", completion: "0.000015", discount: 0 } }]), null);
    assert.equal(catalogDiscount(listed, [{ pricing: { prompt: "0.000005", completion: "0.00003", discount: 0.5 } }]), null);
    assert.equal(catalogDiscount(listed, null), undefined);
    assert.equal(catalogDiscount(listed, undefined), undefined);
  });
});

describe("applyOpenRouter", () => {
  it("lets a router-only family follow the catalog and drops the route's own override", () => {
    const { registry, result } = applyOpenRouter(fixture(), allListed(), TODAY);
    assert.deepEqual(registry.families["deepseek-z"]!.pricing, {
      inputPer1M: 0.0826,
      outputPer1M: 0.1652,
      cachedInputPer1M: 0.01652,
    });
    const route = registry.offerings.find((o) => o.provider === "openrouter" && o.family === "deepseek-z");
    assert.equal(route?.pricing, undefined);
    assert.deepEqual(
      result.changes.map((c) => `${c.target} ${c.field}`),
      ["family deepseek-z pricing", "offering openrouter/deepseek-z pricing"],
    );
    assert.deepEqual(result.notes, []);
  });

  it("moves a router-only family's window and output cap with the catalog", () => {
    const catalog = orCatalog([
      { ...DEEPSEEK_Z_LISTED, context_length: 2_000_000, top_provider: { max_completion_tokens: 400_000 } },
    ]);
    const { registry, result } = applyOpenRouter(fixture(), catalog, TODAY);
    assert.equal(registry.families["deepseek-z"]!.contextWindow, 2_000_000);
    assert.equal(registry.families["deepseek-z"]!.maxTokens, 400_000);
    assert.ok(result.changes.some((c) => c.field === "contextWindow"));
  });

  it("refuses an output cap the catalog puts above the window", () => {
    const catalog = orCatalog([
      { ...DEEPSEEK_Z_LISTED, context_length: 100_000, top_provider: { max_completion_tokens: 400_000 } },
    ]);
    const { registry, result } = applyOpenRouter(fixture(), catalog, TODAY);
    assert.equal(registry.families["deepseek-z"]!.contextWindow, 100_000);
    assert.equal(registry.families["deepseek-z"]!.maxTokens, 384_000);
    assert.match(result.notes.join("\n"), /above the 100000 window/);
  });

  it("keeps a vendor family's numbers and sets the route override only while the router differs", () => {
    // Router now charges the vendor rate: the override goes.
    const agree = applyOpenRouter(
      fixture(),
      orCatalog([{ ...GPT_X_LISTED, pricing: { prompt: "0.000005", completion: "0.00003", input_cache_read: "0.0000005" } }]),
      TODAY,
    );
    assert.deepEqual(agree.registry.families["gpt-x"]!.pricing, { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 0.5 });
    assert.equal(agree.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x")?.pricing, undefined);

    // Router charges something else: the override follows the router, the family does not move.
    const differ = applyOpenRouter(
      fixture(),
      orCatalog([{ ...GPT_X_LISTED, pricing: { prompt: "0.000002", completion: "0.000012", input_cache_read: "0.0000002" } }]),
      TODAY,
    );
    assert.deepEqual(differ.registry.families["gpt-x"]!.pricing, { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 0.5 });
    assert.deepEqual(differ.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x")?.pricing, {
      inputPer1M: 2,
      outputPer1M: 12,
      cachedInputPer1M: 0.2,
    });
  });

  it("leaves an unchanged override alone and says nothing", () => {
    const { result } = applyOpenRouter(fixture(), orCatalog([GPT_X_LISTED]), TODAY);
    assert.deepEqual(result.changes.filter((c) => c.target === "offering openrouter/gpt-x"), []);
  });

  it("carries the default endpoint's discount on the route, and drops it when the promotion ends", () => {
    const discounted = applyOpenRouter(
      fixture(),
      orCatalog([GPT_X_LISTED], {
        endpoints: {
          "openai/gpt-x": [
            { tag: "openai", pricing: { prompt: "0.0000025", completion: "0.000015", discount: 0.5 } },
            { tag: "azure", pricing: { prompt: "0.000005", completion: "0.00003", discount: 0 } },
          ],
        },
      }),
      TODAY,
    );
    const route = discounted.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x");
    assert.deepEqual(route?.pricing, { inputPer1M: 2.5, outputPer1M: 15, cachedInputPer1M: 0.25, discount: 0.5 });

    // Endpoints unreadable the next day: the discount is kept, and said so.
    const unread = applyOpenRouter(
      discounted.registry,
      orCatalog([GPT_X_LISTED], { endpoints: { "openai/gpt-x": null } }),
      TODAY,
    );
    assert.equal(unread.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x")?.pricing?.discount, 0.5);
    assert.match(unread.result.notes.join("\n"), /endpoints could not be read; discount left as it was/);

    // Promotion over: the endpoint at the catalog price carries no discount any more.
    const over = applyOpenRouter(
      discounted.registry,
      orCatalog([GPT_X_LISTED], {
        endpoints: { "openai/gpt-x": [{ tag: "openai", pricing: { prompt: "0.0000025", completion: "0.000015", discount: 0 } }] },
      }),
      TODAY,
    );
    assert.deepEqual(over.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x")?.pricing, {
      inputPer1M: 2.5,
      outputPer1M: 15,
      cachedInputPer1M: 0.25,
    });
  });

  it("puts a router-only family's discount on the family itself", () => {
    const { registry } = applyOpenRouter(
      fixture(),
      orCatalog([DEEPSEEK_Z_LISTED], {
        endpoints: {
          "deepseek/deepseek-z": [{ pricing: { prompt: "0.0000000826", completion: "0.0000001652", discount: 0.41 } }],
        },
      }),
      TODAY,
    );
    assert.equal(registry.families["deepseek-z"]!.pricing.discount, 0.41);
  });

  it("reports a window the router disagrees on for a vendor family, without changing it", () => {
    const { registry, result } = applyOpenRouter(fixture(), orCatalog([{ ...GPT_X_LISTED, context_length: 400_000 }]), TODAY);
    assert.equal(registry.families["gpt-x"]!.contextWindow, 1_050_000);
    assert.match(result.notes.join("\n"), /states a 400000 window/);
  });

  it("starts the retirement clock on a route the catalogs no longer list", () => {
    const { registry, result } = applyOpenRouter(fixture(), orCatalog([]), TODAY);
    for (const family of ["gpt-x", "deepseek-z", "draw-1"]) {
      const route = registry.offerings.find((o) => o.provider === "openrouter" && o.family === family);
      assert.equal(route?.missingSince, TODAY, family);
      assert.equal(route?.hidden, undefined, family);
    }
    assert.equal(result.notes.filter((n) => n.includes("not in OpenRouter's catalog")).length, 3);
  });

  it("looks an image model up in the image catalog, and never prices it from the token one", () => {
    const { registry, result } = applyOpenRouter(
      fixture(),
      orCatalog([{ id: "openai/draw-1", context_length: 400_000, pricing: { prompt: "0.000005", completion: "0.00001" } }], {
        imageIds: ["openai/draw-1"],
      }),
      TODAY,
    );
    assert.deepEqual(registry.families["draw-1"], fixture().families["draw-1"]);
    assert.equal(registry.offerings.find((o) => o.provider === "openrouter" && o.family === "draw-1")?.missingSince, undefined);
    assert.deepEqual(result.changes.filter((c) => c.target.includes("draw-1")), []);
  });

  it("does not mutate the registry it was given", () => {
    const input = fixture();
    applyOpenRouter(input, orCatalog([]), TODAY);
    assert.deepEqual(input, fixture());
  });
});

describe("applyXai", () => {
  const catalog = {
    language: [
      {
        id: "grok-q-0309-reasoning",
        aliases: ["grok-q"],
        prompt_text_token_price: 12_500,
        cached_prompt_text_token_price: 2_000,
        completion_text_token_price: 25_000,
      },
    ],
    imageNames: ["grok-draw", "grok-draw-2026-03-02"],
  };

  it("reads 1e-10 USD ticks as USD per million and matches through aliases", () => {
    const { registry, result } = applyXai(fixture(), catalog, TODAY);
    assert.deepEqual(registry.families["grok-q"]!.pricing, { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 });
    assert.equal(result.changes.length, 1);
    assert.deepEqual(result.notes, []);
  });

  it("leaves a hidden route alone", () => {
    const { registry, result } = applyXai(fixture(), { language: [], imageNames: [] }, TODAY);
    assert.equal(registry.offerings.find((o) => o.family === "grok-old")?.missingSince, undefined);
    assert.ok(!result.notes.some((n) => n.includes("grok-old")));
  });

  it("watches text and image routes in their own catalogs", () => {
    const { registry, result } = applyXai(fixture(), { language: [], imageNames: [] }, TODAY);
    assert.equal(registry.offerings.find((o) => o.family === "grok-q")?.missingSince, TODAY);
    assert.equal(registry.offerings.find((o) => o.family === "grok-draw")?.missingSince, TODAY);
    assert.equal(result.notes.length, 2);
  });
});

describe("applyAnthropic", () => {
  it("strips a dated snapshot to its alias", () => {
    assert.equal(undated("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.equal(undated("claude-opus-5"), "claude-opus-5");
  });

  it("moves the family's window and output cap from the catalog, matched on the wire id", () => {
    const { registry, result } = applyAnthropic(
      fixture(),
      [{ id: "claude-y-1-20260101", max_input_tokens: 1_000_000, max_tokens: 128_000 }],
      TODAY,
    );
    assert.equal(registry.families["claude-y.1"]!.contextWindow, 1_000_000);
    assert.equal(registry.families["claude-y.1"]!.maxTokens, 128_000);
    assert.equal(result.changes.length, 2);
  });

  it("prefers the undated id when the catalog lists both", () => {
    const { registry } = applyAnthropic(
      fixture(),
      [
        { id: "claude-y-1-20260101", max_input_tokens: 200_000, max_tokens: 64_000 },
        { id: "claude-y-1", max_input_tokens: 1_000_000, max_tokens: 128_000 },
      ],
      TODAY,
    );
    assert.equal(registry.families["claude-y.1"]!.contextWindow, 1_000_000);
  });

  it("starts the retirement clock on a missing model, and reports an entry without limits", () => {
    const missing = applyAnthropic(fixture(), [], TODAY);
    assert.equal(missing.registry.offerings.find((o) => o.provider === "anthropic")?.missingSince, TODAY);
    assert.deepEqual(applyAnthropic(fixture(), [{ id: "claude-y-1" }], TODAY).result.notes, [
      "anthropic/claude-y.1: catalog entry carries no limits",
    ]);
  });
});

describe("applyOpenAi", () => {
  it("only watches presence, and only on live routes", () => {
    const { registry, result } = applyOpenAi(fixture(), ["draw-1"], TODAY);
    assert.equal(registry.offerings.find((o) => o.provider === "openai" && o.family === "gpt-x")?.missingSince, TODAY);
    assert.equal(registry.offerings.find((o) => o.provider === "openai" && o.family === "draw-1")?.missingSince, undefined);
    assert.equal(result.changes.length, 1);
  });
});
