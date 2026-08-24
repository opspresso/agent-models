import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateRegistry, type PlacedOffering, type Registry } from "../src/registry.ts";
import {
  DISCOVERY_WINDOW_DAYS,
  OPENROUTER_IMAGE_MODELS_URL,
  OPENROUTER_IMAGE_RANKINGS_URL,
  OPENROUTER_MODELS_URL,
  OPENROUTER_RANKINGS_URL,
  applyOpenRouter,
  catalogDiscount,
  discoverOpenRouter,
  discoveryEndpointIds,
  fetchOpenRouterCatalog,
  resetOpenRouterRegistry,
  type OpenRouterCatalog,
  type OpenRouterModel,
} from "../src/sources/openrouter.ts";
import { applyXai, discoverXai, fetchXaiCatalog } from "../src/sources/xai.ts";
import { applyAnthropic, discoverAnthropic, undated } from "../src/sources/anthropic.ts";
import { applyOpenAi, discoverOpenAi } from "../src/sources/openai.ts";
import { applyGoogle, discoverGoogle, fetchGoogleModels } from "../src/sources/google.ts";
import { daysBetween, observePresence, observeRankingEligibility, RANKING_GRACE_OBSERVATIONS, RETIREMENT_GRACE_OBSERVATIONS } from "../src/sources/presence.ts";
import { addRoute, promoteFamily, undiscounted } from "../src/sources/routes.ts";
import { fetchJson, perMillion, type Change } from "../src/sources/types.ts";

const TEXT = { tools: true, structuredOutput: true, imageInput: true, reasoning: true };
const TODAY = "2026-08-20";

function fixture(): Registry {
  return {
    providers: ["openai", "anthropic", "xai", "google", "openrouter"],
    makers: {
      openai: { displayName: "OpenAI", openrouterVendor: "openai" },
      anthropic: { displayName: "Anthropic", openrouterVendor: "anthropic" },
      xai: { displayName: "xAI", openrouterVendor: "x-ai" },
      deepseek: { displayName: "DeepSeek", openrouterVendor: "deepseek" },
      google: { displayName: "Google", openrouterVendor: "google" },
    },
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
  return { models, imageIds: [], imageModels: [], endpoints: {}, rankings: [], imageRankings: [], ...extra };
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

describe("fetchJson", () => {
  it("refuses redirects and applies a request timeout", async () => {
    let received: RequestInit | undefined;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      received = init;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    assert.deepEqual(await fetchJson("https://example.test/catalog", {}, fetchFn), { ok: true });
    assert.equal(received?.redirect, "error");
    assert.ok(received?.signal instanceof AbortSignal);
  });

  it("rejects an oversized JSON response", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: "x".repeat(11 * 1024 * 1024) }))) as typeof fetch;
    await assert.rejects(fetchJson("https://example.test/catalog", {}, fetchFn), /larger than/);
  });
});

describe("observePresence", () => {
  it("counts whole UTC days", () => {
    assert.equal(daysBetween("2026-08-20", "2026-08-27"), 7);
    assert.equal(daysBetween("2026-08-31", "2026-09-01"), 1);
  });

  it("counts successful absence observations, not elapsed days or same-day retries", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", note: "Kept." };
    const changes: Change[] = [];
    let notes: string[] = [];
    observePresence(offering, false, "OpenAI", "2026-08-20", changes, notes);
    assert.equal(offering.missingSince, "2026-08-20");
    assert.equal(offering.missingObservations, 1);

    notes = [];
    observePresence(offering, false, "OpenAI", "2026-08-23", changes, notes);
    observePresence(offering, false, "OpenAI", "2026-08-23", changes, notes);
    assert.equal(offering.missingSince, "2026-08-20");
    assert.equal(offering.hidden, undefined);
    assert.equal(offering.missingObservations, 2);
    assert.match(notes[0] ?? "", /2 of 7 successful observations/);

    notes = [];
    for (const day of ["2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"]) {
      observePresence(offering, false, "OpenAI", day, changes, notes);
    }
    assert.equal(offering.hidden, true);
    assert.equal(offering.hiddenReason, "catalog");
    assert.equal(offering.missingSince, undefined);
    assert.equal(offering.note, "Kept. Hidden automatically on 2026-08-31: absent from OpenAI's catalog since 2026-08-20.");
    assert.match(notes.at(-1) ?? "", /hidden — Hidden automatically/);
    assert.equal(RETIREMENT_GRACE_OBSERVATIONS, 7);
  });

  it("clears the clock the day the model is back", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", missingSince: "2026-08-20", missingObservations: 2, lastMissingAt: "2026-08-21" };
    const changes: Change[] = [];
    observePresence(offering, true, "OpenAI", "2026-08-25", changes, []);
    assert.equal(offering.missingSince, undefined);
    assert.deepEqual(changes.map((c) => [c.field, c.to]), [["missingSince", undefined]]);
  });

  it("restores a route hidden automatically when it returns", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", hidden: true, hiddenReason: "catalog" };
    const changes: Change[] = [];
    observePresence(offering, true, "OpenAI", "2026-08-25", changes, []);
    assert.equal(offering.hidden, undefined);
    assert.equal(offering.hiddenReason, undefined);
    assert.deepEqual(changes.map((change) => change.field), ["hidden"]);
  });

  it("does not watch a hidden route", () => {
    const offering: PlacedOffering = { provider: "openai", family: "gpt-x", hidden: true };
    const notes: string[] = [];
    observePresence(offering, false, "OpenAI", "2026-08-20", [], notes);
    assert.deepEqual(notes, []);
    assert.equal(offering.missingSince, undefined);
  });

  it("hides after 14 successful ranking misses and restores on re-entry", () => {
    const offering: PlacedOffering = { provider: "openrouter", family: "deepseek-z", wireId: "deepseek/deepseek-z" };
    const changes: Change[] = [];
    for (let day = 1; day <= RANKING_GRACE_OBSERVATIONS; day += 1) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      observeRankingEligibility(offering, false, date, changes, []);
      observeRankingEligibility(offering, false, date, changes, []);
    }
    assert.equal(offering.hidden, true);
    assert.equal(offering.hiddenReason, "ranking");
    observeRankingEligibility(offering, true, "2026-09-15", changes, []);
    assert.equal(offering.hidden, undefined);
    assert.equal(offering.hiddenReason, undefined);
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

  it("refreshes a router-only family's output cap from endpoints when the aggregate cap is missing", () => {
    const model = { ...DEEPSEEK_Z_LISTED, top_provider: { max_completion_tokens: null } };
    const catalog = orCatalog([model], {
      endpoints: {
        [model.id]: [
          { context_length: 1_048_576, max_completion_tokens: 131_072 },
          { context_length: 1_048_576, max_completion_tokens: 262_144 },
        ],
      },
    });
    const { registry } = applyOpenRouter(fixture(), catalog, TODAY);
    assert.equal(registry.families["deepseek-z"]!.maxTokens, 262_144);
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Unix seconds for a UTC date. */
const at = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
const RECENT = at("2026-08-15");
const OLD = at("2026-01-10");
const NEW_TEXT_PERMASLUG = "deepseek/deepseek-z2-20260815";

const NEW_TEXT: OpenRouterModel = {
  id: "deepseek/deepseek-z2",
  canonical_slug: NEW_TEXT_PERMASLUG,
  hugging_face_id: "deepseek-ai/DeepSeek-Z2",
  name: "DeepSeek: DeepSeek Z2",
  created: RECENT,
  context_length: 1_000_000,
  pricing: { prompt: "0.0000002", completion: "0.0000008", input_cache_read: "0.00000002" },
  top_provider: { max_completion_tokens: 128_000 },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools", "reasoning", "response_format"],
};

const NEW_TEXT_RANKING = {
  model_permaslug: NEW_TEXT_PERMASLUG,
  variant_permaslug: NEW_TEXT_PERMASLUG,
  total_completion_tokens: 200,
  total_prompt_tokens: 800,
};

const IMAGE_MODEL = {
  id: "krea/krea-2-medium",
  name: "Krea: Krea 2 Medium",
  created: OLD,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
};

const IMAGE_RANKING = {
  model_permaslug: "krea/krea-2-medium-20260720",
  variant_permaslug: "krea/krea-2-medium-20260720",
  image_output_requests: 10_000,
};

describe("undiscounted / promoteFamily", () => {
  it("puts the list price back and drops the discount", () => {
    assert.deepEqual(undiscounted({ inputPer1M: 2.5, outputPer1M: 15, cachedInputPer1M: 0.25, discount: 0.5 }), {
      inputPer1M: 5,
      outputPer1M: 30,
      cachedInputPer1M: 0.5,
    });
    assert.deepEqual(undiscounted({ inputPer1M: 1, outputPer1M: 2 }), { inputPer1M: 1, outputPer1M: 2 });
  });

  it("promotes only a router-only family that carries a discount", () => {
    const r = fixture();
    r.families["deepseek-z"]!.pricing.discount = 0.5;
    const changes: Change[] = [];
    promoteFamily(r, "deepseek-z", changes);
    assert.deepEqual(r.families["deepseek-z"]!.pricing, { inputPer1M: 0.28, outputPer1M: 0.56, cachedInputPer1M: 0.056 });
    assert.equal(changes.length, 1);
    promoteFamily(r, "gpt-x", changes); // vendor-routed already: nothing
    assert.equal(changes.length, 1);
  });
});

describe("addRoute", () => {
  it("adds a route once, and never to a retired family", () => {
    const r = fixture();
    const changes: Change[] = [];
    assert.equal(addRoute(r, { provider: "openrouter", family: "grok-q", wireId: "x-ai/grok-q" }, changes), true);
    assert.equal(addRoute(r, { provider: "openrouter", family: "grok-q", wireId: "x-ai/grok-q" }, changes), false);
    assert.equal(addRoute(r, { provider: "openrouter", family: "grok-old", wireId: "x-ai/grok-old" }, changes), false);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.field, "added");
  });
});

describe("discoverOpenRouter", () => {
  it("adds a weekly top-20 image model, its maker, and its route from endpoint metadata", () => {
    const { registry } = discoverOpenRouter(
      fixture(),
      orCatalog([], {
        imageIds: [IMAGE_MODEL.id],
        imageModels: [IMAGE_MODEL],
        imageRankings: [IMAGE_RANKING],
        endpoints: {
          [IMAGE_MODEL.id]: [
            {
              tag: "krea/flex",
              context_length: 65_536,
              pricing: { prompt: "0", completion: "0", image_output: "0.000005" },
            },
            {
              tag: "krea",
              context_length: 65_536,
              pricing: { prompt: "0", completion: "0", image_output: "0.00001" },
            },
          ],
        },
      }),
      TODAY,
    );
    assert.deepEqual(registry.makers.krea, { displayName: "Krea", openrouterVendor: "krea" });
    assert.deepEqual(registry.families["krea-2-medium"], {
      maker: "krea",
      displayName: "Krea 2 Medium",
      pricing: { inputPer1M: 0, outputPer1M: 0, imageOutputPer1M: 10 },
      capabilities: {
        tools: false,
        structuredOutput: false,
        imageInput: true,
        reasoning: false,
        imageGeneration: true,
      },
      contextWindow: 65_536,
      maxTokens: 65_536,
      note: "Added automatically on 2026-08-20 from OpenRouter's weekly image top 20; numbers and flags are OpenRouter's.",
    });
    assert.ok(registry.offerings.some((offering) => offering.wireId === IMAGE_MODEL.id));
  });

  it("keeps explicit zero limits for a ranked image-only model", () => {
    const { registry } = discoverOpenRouter(
      fixture(),
      orCatalog([], {
        imageIds: [IMAGE_MODEL.id],
        imageModels: [IMAGE_MODEL],
        imageRankings: [IMAGE_RANKING],
        endpoints: {
          [IMAGE_MODEL.id]: [{
            context_length: 0,
            max_completion_tokens: 0,
            pricing: { image_output: "0.00001" },
          }],
        },
      }),
      TODAY,
    );
    assert.equal(registry.families["krea-2-medium"]!.contextWindow, 0);
    assert.equal(registry.families["krea-2-medium"]!.maxTokens, 0);
  });

  it("does not add the image leaderboard's 21st model", () => {
    const higher = Array.from({ length: 20 }, (_, index) => ({
      model_permaslug: `other/image-${index}`,
      variant_permaslug: `other/image-${index}`,
      image_output_requests: 100 - index,
    }));
    const { registry } = discoverOpenRouter(
      fixture(),
      orCatalog([], {
        imageIds: [IMAGE_MODEL.id],
        imageModels: [IMAGE_MODEL],
        imageRankings: [...higher, { ...IMAGE_RANKING, image_output_requests: 1 }],
        endpoints: {
          [IMAGE_MODEL.id]: [{
            context_length: 65_536,
            pricing: { prompt: "0", completion: "0", image_output: "0.00001" },
          }],
        },
      }),
      TODAY,
    );
    assert.equal(registry.families["krea-2-medium"], undefined);
    assert.equal(registry.makers.krea, undefined);
  });

  it("resets only OpenRouter offerings as recoverable tombstones", () => {
    const { registry, deactivatedOfferings } = resetOpenRouterRegistry(fixture());
    assert.equal(deactivatedOfferings, 3);
    assert.ok(registry.offerings.filter((offering) => offering.provider === "openrouter").every(
      (offering) => offering.hidden && offering.hiddenReason === "reset",
    ));
    assert.ok(registry.families["deepseek-z"]);
    assert.ok(registry.families["gpt-x"]);
    assert.ok(registry.families["draw-1"]);
  });

  it("bootstraps an older ranked model after an OpenRouter reset", () => {
    const reset = resetOpenRouterRegistry(fixture()).registry;
    const oldRanked = { ...NEW_TEXT, created: OLD };
    const { registry } = discoverOpenRouter(
      reset,
      orCatalog([oldRanked], { rankings: [NEW_TEXT_RANKING] }),
      TODAY,
      { bootstrap: true },
    );
    assert.ok(registry.families["deepseek-z2"]);
    assert.ok(registry.offerings.some((offering) => offering.wireId === "deepseek/deepseek-z2"));
  });

  it("adds a recent, priced text model of a known maker as a new family with its route", () => {
    const { registry, result } = discoverOpenRouter(fixture(), orCatalog([NEW_TEXT], { rankings: [NEW_TEXT_RANKING] }), TODAY);
    const family = registry.families["deepseek-z2"];
    assert.ok(family);
    assert.equal(family.maker, "deepseek");
    assert.equal(family.displayName, "DeepSeek Z2");
    assert.deepEqual(family.pricing, { inputPer1M: 0.2, outputPer1M: 0.8, cachedInputPer1M: 0.02 });
    assert.deepEqual(family.capabilities, { tools: true, structuredOutput: false, imageInput: false, reasoning: true });
    assert.equal(family.contextWindow, 1_000_000);
    assert.equal(family.maxTokens, 128_000);
    assert.match(family.note ?? "", /Added automatically on 2026-08-20 from OpenRouter/);
    assert.deepEqual(
      registry.offerings.find((o) => o.family === "deepseek-z2"),
      { provider: "openrouter", family: "deepseek-z2", wireId: "deepseek/deepseek-z2" },
    );
    assert.deepEqual(result.changes.map((c) => c.field), ["added"]);
  });

  it("adds an eligible text model from its largest usable endpoint cap when the aggregate cap is missing", () => {
    const input = fixture();
    input.makers.moonshot = { displayName: "Moonshot AI", openrouterVendor: "moonshotai" };
    const model = {
      ...NEW_TEXT,
      id: "moonshotai/kimi-k3",
      canonical_slug: "moonshotai/kimi-k3-20260715",
      name: "MoonshotAI: Kimi K3",
      created: OLD,
      context_length: 1_048_576,
      top_provider: { max_completion_tokens: null },
    };
    const ranking = {
      ...NEW_TEXT_RANKING,
      model_permaslug: model.canonical_slug,
      variant_permaslug: model.canonical_slug,
    };
    const { registry, result } = discoverOpenRouter(
      input,
      orCatalog([model], {
        endpoints: {
          [model.id]: [
            { context_length: 1_048_576, max_completion_tokens: 16_384 },
            { context_length: 1_048_576, max_completion_tokens: 262_144 },
            { context_length: 65_536, max_completion_tokens: 131_072 },
          ],
        },
        rankings: [ranking],
      }),
      TODAY,
    );
    assert.equal(registry.families["kimi-k3"]?.maxTokens, 262_144);
    assert.ok(registry.offerings.some((offering) => offering.wireId === model.id));
    assert.ok(!result.notes.some((note) => note.includes("no usable max output")));
  });

  it("carries the listing's discount on a new router-only family", () => {
    const catalog = orCatalog([NEW_TEXT], {
      endpoints: { "deepseek/deepseek-z2": [{ pricing: { prompt: "0.0000002", completion: "0.0000008", discount: 0.25 } }] },
      rankings: [NEW_TEXT_RANKING],
    });
    const { registry } = discoverOpenRouter(fixture(), catalog, TODAY);
    assert.equal(registry.families["deepseek-z2"]!.pricing.discount, 0.25);
  });

  it("leaves the backlog, variants, dated snapshots and unpriced listings alone", () => {
    const { registry, result } = discoverOpenRouter(
      fixture(),
      orCatalog([
        { ...NEW_TEXT, created: OLD },
        { ...NEW_TEXT, id: "deepseek/deepseek-z2:free", pricing: { prompt: "0", completion: "0" } },
        { ...NEW_TEXT, id: "deepseek/deepseek-z2-0815" },
        { ...NEW_TEXT, id: "deepseek/deepseek-z3", pricing: { prompt: "0", completion: "0" } },
      ]),
      TODAY,
    );
    assert.deepEqual(Object.keys(registry.families), Object.keys(fixture().families));
    assert.deepEqual(result.changes, []);
    assert.match(result.notes.join("\n"), /outside the OpenRouter ranking policy/);
  });

  it("reports what it will not add: an unknown maker and a listing without an output cap", () => {
    const { registry, result } = discoverOpenRouter(
      fixture(),
      orCatalog([
        { ...NEW_TEXT, id: "mistralai/mistral-z", canonical_slug: "mistralai/mistral-z", name: "Mistral: Z" },
        { ...NEW_TEXT, id: "deepseek/deepseek-nocap", canonical_slug: "deepseek/deepseek-nocap", top_provider: { max_completion_tokens: null } },
      ], {
        rankings: [
          { ...NEW_TEXT_RANKING, model_permaslug: "mistralai/mistral-z", variant_permaslug: "mistralai/mistral-z" },
          { ...NEW_TEXT_RANKING, model_permaslug: "deepseek/deepseek-nocap", variant_permaslug: "deepseek/deepseek-nocap" },
        ],
      }),
      TODAY,
    );
    assert.deepEqual(Object.keys(registry.families), Object.keys(fixture().families));
    const notes = result.notes.join("\n");
    assert.match(notes, /1 eligible model from "mistralai", not a known maker \(mistral-z\)/);
    assert.match(notes, /deepseek\/deepseek-nocap states no usable max output/);
  });

  it("notes a listing whose own spelling cannot be a registry id, and adds the rest", () => {
    const { registry, result } = discoverOpenRouter(
      fixture(),
      orCatalog([
        { ...NEW_TEXT, id: "deepseek/DeepSeek-Z2", canonical_slug: "deepseek/DeepSeek-Z2" },
        { ...NEW_TEXT, id: "deepseek/deepseek-z3", canonical_slug: "deepseek/deepseek-z3" },
      ], {
        rankings: [
          { ...NEW_TEXT_RANKING, model_permaslug: "deepseek/DeepSeek-Z2", variant_permaslug: "deepseek/DeepSeek-Z2" },
          { ...NEW_TEXT_RANKING, model_permaslug: "deepseek/deepseek-z3", variant_permaslug: "deepseek/deepseek-z3" },
        ],
      }),
      TODAY,
    );
    assert.ok(!Object.keys(registry.families).includes("DeepSeek-Z2"));
    assert.ok(Object.keys(registry.families).includes("deepseek-z3"));
    assert.match(result.notes.join("\n"), /deepseek\/DeepSeek-Z2 cannot be a family id/);
    // The whole point: the run stays writable instead of failing validation.
    assert.deepEqual(validateRegistry(registry), []);
  });

  it("adds recent models from the four major makers without a ranking", () => {
    const models = [
      { vendor: "openai", slug: "gpt-z" },
      { vendor: "anthropic", slug: "claude-z" },
      { vendor: "google", slug: "gemini-z" },
      { vendor: "x-ai", slug: "grok-z" },
    ].map(({ vendor, slug }) => ({
      ...NEW_TEXT,
      id: `${vendor}/${slug}`,
      canonical_slug: `${vendor}/${slug}-20260815`,
      hugging_face_id: null,
    }));
    const { registry } = discoverOpenRouter(fixture(), orCatalog(models, { rankings: null }), TODAY);
    for (const model of models) {
      assert.ok(registry.offerings.some((offering) => offering.wireId === model.id), model.id);
    }
  });

  it("adds only the first 20 open and first 20 closed ranking rows from other makers", () => {
    const models = Array.from({ length: 42 }, (_, index) => {
      const open = index < 21;
      const number = index % 21 + 1;
      const slug = `${open ? "open" : "closed"}-${number}`;
      return {
        ...NEW_TEXT,
        id: `deepseek/${slug}`,
        canonical_slug: `deepseek/${slug}-20260815`,
        hugging_face_id: open ? `deepseek-ai/${slug}` : null,
      };
    });
    const rankings = models.map((model, index) => ({
      model_permaslug: model.canonical_slug,
      variant_permaslug: model.canonical_slug,
      total_completion_tokens: 0,
      total_prompt_tokens: 21 - index % 21,
    }));
    const { registry } = discoverOpenRouter(fixture(), orCatalog(models, { rankings }), TODAY);
    assert.equal(registry.offerings.filter((offering) => offering.family.startsWith("open-")).length, 20);
    assert.equal(registry.offerings.filter((offering) => offering.family.startsWith("closed-")).length, 20);
    assert.ok(!registry.families["open-21"]);
    assert.ok(!registry.families["closed-21"]);
  });

  it("fails closed for a non-major maker when rankings are unavailable", () => {
    const { registry, result } = discoverOpenRouter(fixture(), orCatalog([NEW_TEXT], { rankings: null }), TODAY);
    assert.equal(registry.families["deepseek-z2"], undefined);
    assert.match(result.notes.join("\n"), /rankings could not be read/);
  });

  it("adds an OpenRouter route to a family it already has, narrowing capabilities the router lacks", () => {
    const { registry, result } = discoverOpenRouter(
      fixture(),
      orCatalog([
        { ...NEW_TEXT, id: "x-ai/grok-q", created: OLD, context_length: 500_000, supported_parameters: ["tools"] },
      ]),
      TODAY,
    );
    const route = registry.offerings.find((o) => o.provider === "openrouter" && o.family === "grok-q");
    assert.deepEqual(route, { provider: "openrouter", family: "grok-q", wireId: "x-ai/grok-q", capabilities: { structuredOutput: false } });
    assert.equal(result.changes.length, 1);
  });

  it("does not route a same-named listing whose window says it is another model", () => {
    const { registry, result } = discoverOpenRouter(
      fixture(),
      orCatalog([{ ...NEW_TEXT, id: "x-ai/grok-q", created: OLD, context_length: 131_072 }]),
      TODAY,
    );
    assert.ok(!registry.offerings.some((o) => o.provider === "openrouter" && o.family === "grok-q"));
    assert.match(result.notes.join("\n"), /x-ai\/grok-q could route family "grok-q", but states a 131072 window/);
  });

  it("skips an id it already routes to under another family name", () => {
    const r = fixture();
    r.offerings.push({ provider: "openrouter", family: "grok-q", wireId: "x-ai/grokq" });
    const { registry, result } = discoverOpenRouter(r, orCatalog([{ ...NEW_TEXT, id: "x-ai/grokq", created: RECENT }]), TODAY);
    assert.equal(registry.families["grokq"], undefined);
    assert.deepEqual(result.changes, []);
  });

  it("does not resurrect a retired family, re-route an image family, or cross makers", () => {
    const r = fixture();
    r.families["grok-old"]!.maker = "xai";
    const { registry, result } = discoverOpenRouter(
      r,
      orCatalog([
        { ...NEW_TEXT, id: "x-ai/grok-old", created: OLD },
        { ...NEW_TEXT, id: "x-ai/grok-draw", created: OLD },
        { ...NEW_TEXT, id: "anthropic/gpt-x", created: OLD },
      ]),
      TODAY,
    );
    assert.equal(registry.offerings.length, fixture().offerings.length);
    assert.match(result.notes.join("\n"), /anthropic\/gpt-x names family "gpt-x", which this registry files under openai/);
  });

  it("names the endpoints discovery wants read", () => {
    const ids = discoveryEndpointIds(
      fixture(),
      // The dated snapshot is recent and vendor-known, but discovery would
      // skip it anyway — its endpoints are a wasted read.
      [NEW_TEXT, { ...NEW_TEXT, id: "mistralai/x" }, { ...NEW_TEXT, id: "deepseek/old", created: OLD }, { ...NEW_TEXT, id: "x-ai/grok-q", created: OLD }, { ...NEW_TEXT, id: "openai/gpt-x-20260101" }, { ...NEW_TEXT, id: "openai/gpt-x-2026-01-01" }],
      TODAY,
      [NEW_TEXT_RANKING],
    );
    assert.deepEqual(ids, ["deepseek/deepseek-z2", "deepseek/old", "x-ai/grok-q"]);
    assert.equal(DISCOVERY_WINDOW_DAYS, 30);
  });

  it("reads endpoints for older eligible models during a bootstrap", () => {
    const oldRanked = { ...NEW_TEXT, created: OLD };
    const ids = discoveryEndpointIds(
      resetOpenRouterRegistry(fixture()).registry,
      [oldRanked, { ...oldRanked, id: "deepseek/unranked", canonical_slug: "deepseek/unranked" }],
      TODAY,
      [NEW_TEXT_RANKING],
      { bootstrap: true },
    );
    assert.deepEqual(ids, ["deepseek/deepseek-z2"]);
  });
});

describe("vendor route discovery", () => {
  it("xAI: routes a live xAI family the catalog names, and promotes a router-only family", () => {
    const r = fixture();
    // grok-q served only via OpenRouter, with a discount.
    r.offerings = r.offerings.filter((o) => !(o.provider === "xai" && o.family === "grok-q"));
    r.offerings.push({ provider: "openrouter", family: "grok-q", wireId: "x-ai/grok-q" });
    r.families["grok-q"]!.pricing = { inputPer1M: 1, outputPer1M: 3, discount: 0.5 };
    const { registry, result } = discoverXai(r, { language: [{ id: "grok-q-0309", aliases: ["grok-q"] }], imageNames: [] });
    assert.deepEqual(registry.offerings.find((o) => o.provider === "xai" && o.family === "grok-q"), { provider: "xai", family: "grok-q" });
    assert.deepEqual(registry.families["grok-q"]!.pricing, { inputPer1M: 2, outputPer1M: 6 });
    assert.deepEqual(result.changes.map((c) => c.field), ["pricing", "added"]);
  });

  it("Anthropic: routes with the hyphenated wire id", () => {
    const r = fixture();
    r.offerings = r.offerings.filter((o) => o.provider !== "anthropic");
    r.offerings.push({ provider: "openrouter", family: "claude-y.1", wireId: "anthropic/claude-y.1" });
    const { registry } = discoverAnthropic(r, [{ id: "claude-y-1-20260101" }]);
    assert.deepEqual(registry.offerings.find((o) => o.provider === "anthropic"), { provider: "anthropic", family: "claude-y.1", wireId: "claude-y-1" });
  });

  it("OpenAI: routes a text family the catalog lists, not an image one", () => {
    const r = fixture();
    r.offerings = r.offerings.filter((o) => o.provider !== "openai");
    r.offerings.push({ provider: "openrouter", family: "draw-1", wireId: "openai/draw-1" });
    const { registry } = discoverOpenAi(r, ["gpt-x", "draw-1"]);
    // gpt-x still has its openrouter route, so it is live and gets the vendor route back.
    assert.ok(registry.offerings.some((o) => o.provider === "openai" && o.family === "gpt-x"));
    assert.ok(!registry.offerings.some((o) => o.provider === "openai" && o.family === "draw-1"));
  });

  it("Google: watches presence and limits, and routes a family the API serves", () => {
    const r = fixture();
    r.families["gemini-z"] = {
      maker: "google",
      displayName: "Gemini Z",
      pricing: { inputPer1M: 0.5, outputPer1M: 3 },
      capabilities: TEXT,
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    };
    r.offerings.push({ provider: "openrouter", family: "gemini-z", wireId: "google/gemini-z" });
    const catalog = [
      { name: "models/gemini-z", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-z", inputTokenLimit: 2048, supportedGenerationMethods: ["embedContent"] },
    ];
    const discovered = discoverGoogle(r, catalog);
    assert.deepEqual(discovered.registry.offerings.find((o) => o.provider === "google"), { provider: "google", family: "gemini-z" });
    const applied = applyGoogle(discovered.registry, catalog, TODAY);
    assert.equal(applied.registry.families["gemini-z"]!.contextWindow, 1_048_576);
    const missing = applyGoogle(discovered.registry, [], TODAY);
    assert.equal(missing.registry.offerings.find((o) => o.provider === "google")?.missingSince, TODAY);
  });

  it("OpenRouter: an empty image catalog is a failed read, not a mass retirement", async () => {
    // Six image routes live only in /images/models; an empty answer read as
    // data would start the retirement clock on all of them at once.
    const fetchFn = (async (url: string | URL | Request) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () =>
        String(url).includes("/images/models")
          ? { data: [] }
          : String(url) === OPENROUTER_MODELS_URL
            ? { data: [{ id: "openai/gpt-x", pricing: { prompt: "0.000005", completion: "0.00003" } }], total_count: 1, links: { next: null } }
            : { data: [{ id: "openai/gpt-x" }] },
    })) as unknown as typeof fetch;
    await assert.rejects(fetchOpenRouterCatalog(() => [], fetchFn), (error: Error) => {
      assert.ok(error.message.includes(OPENROUTER_IMAGE_MODELS_URL));
      assert.ok(error.message.includes("empty catalog"));
      return true;
    });
  });

  it("Google: credits presence under either spelling — the wire name or the family", () => {
    // gemini-3.1-pro is the case in hand: dispatch needs the -preview wire
    // name, while which spelling the native catalog lists has been observed to
    // vary. Only-one-spelling credit starts the clock on a model that answers.
    const r = fixture();
    r.families["gemini-w"] = {
      maker: "google",
      displayName: "Gemini W",
      pricing: { inputPer1M: 2, outputPer1M: 12 },
      capabilities: TEXT,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    };
    r.offerings.push({ provider: "google", family: "gemini-w", wireId: "gemini-w-preview" });
    const byWire = applyGoogle(r, [{ name: "models/gemini-w-preview", supportedGenerationMethods: ["generateContent"] }], TODAY);
    assert.equal(byWire.registry.offerings.find((o) => o.family === "gemini-w")?.missingSince, undefined);
    const byFamily = applyGoogle(r, [{ name: "models/gemini-w", supportedGenerationMethods: ["generateContent"] }], TODAY);
    assert.equal(byFamily.registry.offerings.find((o) => o.family === "gemini-w")?.missingSince, undefined);
    const byNeither = applyGoogle(r, [{ name: "models/other", supportedGenerationMethods: ["generateContent"] }], TODAY);
    assert.equal(byNeither.registry.offerings.find((o) => o.family === "gemini-w")?.missingSince, TODAY);
  });
});

describe("fetch guards and snapshot folding", () => {
  const jsonResponse = (body: unknown) =>
    ({ ok: true, status: 200, statusText: "OK", json: async () => body }) as unknown as Response;

  it("OpenRouter: entries that carry no id are the same failed read", async () => {
    const fetchFn = (async (url: string | URL | Request) =>
      jsonResponse(
        String(url).includes("/images/models")
          ? { data: [{ id: "openai/gpt-image-2" }] }
          : String(url) === OPENROUTER_MODELS_URL
            ? { data: [{ slug: "renamed-field" }], total_count: 1, links: { next: null } }
            : { data: [{ slug: "renamed-field" }] },
      )) as unknown as typeof fetch;
    await assert.rejects(fetchOpenRouterCatalog(() => [], fetchFn), /no usable entries/);
  });

  it("OpenRouter: a failed rankings read leaves the provider catalog usable but the rankings unavailable", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target === OPENROUTER_RANKINGS_URL) {
        return { ok: false, status: 503, statusText: "Unavailable", json: async () => ({}) } as Response;
      }
      if (target === OPENROUTER_IMAGE_RANKINGS_URL) {
        return jsonResponse({ data: [IMAGE_RANKING] });
      }
      return jsonResponse(
        target.includes("/images/models")
          ? { data: [{ id: "openai/gpt-image-2" }] }
          : target === OPENROUTER_MODELS_URL
            ? { data: [{ id: "openai/gpt-x", canonical_slug: "openai/gpt-x-20260815" }], total_count: 1, links: { next: null } }
            : { data: [{ id: "openai/gpt-x", canonical_slug: "openai/gpt-x-20260815" }] },
      );
    }) as unknown as typeof fetch;
    const catalog = await fetchOpenRouterCatalog(() => [], fetchFn);
    assert.equal(catalog.rankings, null);
    assert.equal(catalog.imageRankings, null);
    assert.deepEqual(catalog.models.map((model) => model.id), ["openai/gpt-x"]);
  });

  it("OpenRouter: rejects catalog truncation and marks a malformed endpoint response unreadable", async () => {
    const partialFetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target === OPENROUTER_MODELS_URL) {
        return jsonResponse({ data: [{ id: "openai/gpt-x" }], total_count: 2, links: { next: "next" } });
      }
      return jsonResponse({ data: [{ id: "openai/gpt-image-2" }] });
    }) as unknown as typeof fetch;
    await assert.rejects(fetchOpenRouterCatalog(() => [], partialFetch), /partial catalog/);

    const malformedEndpoint = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/endpoints")) return jsonResponse({ data: {} });
      if (target.includes("/images/models")) return jsonResponse({ data: [{ id: "openai/gpt-image-2" }] });
      return target === OPENROUTER_MODELS_URL
        ? jsonResponse({ data: [{ id: "openai/gpt-x" }], total_count: 1, links: { next: null } })
        : jsonResponse({ data: [{ id: "openai/gpt-x" }] });
    }) as unknown as typeof fetch;
    const catalog = await fetchOpenRouterCatalog(() => ["openai/gpt-x"], malformedEndpoint);
    assert.equal(catalog.endpoints["openai/gpt-x"], null);
  });

  it("xAI: an image catalog whose entries carry no id is a failed read too", async () => {
    const fetchFn = (async (url: string | URL | Request) =>
      jsonResponse(
        String(url).includes("image-generation")
          ? { models: [{ modelId: "renamed" }] }
          : { models: [{ id: "grok-x" }] },
      )) as unknown as typeof fetch;
    await assert.rejects(fetchXaiCatalog("key", fetchFn), /image-generation-models.*no usable entries/);
  });

  it("Google: raw entries none of which are usable is a failed read, not a catalog", async () => {
    const fetchFn = (async () =>
      jsonResponse({ models: [{ name: "models/embed-x", supportedGenerationMethods: ["embedContent"] }] })) as unknown as typeof fetch;
    await assert.rejects(fetchGoogleModels("key", fetchFn), /no usable entries/);
  });

  it("xAI: language entries that carry no id are the same failed read", async () => {
    const fetchFn = (async () => jsonResponse({ models: [{ modelId: "renamed-field" }] })) as unknown as typeof fetch;
    await assert.rejects(fetchXaiCatalog("key", fetchFn), /no usable entries/);
  });

  it("OpenAI: routes a family its catalog lists only as a dated snapshot — the same fold presence uses", () => {
    for (const listing of ["gpt-x-20260101", "gpt-x-2026-01-01"]) {
      const r = fixture();
      r.offerings = r.offerings.filter((o) => o.provider !== "openai");
      const { registry } = discoverOpenAi(r, [listing]);
      assert.ok(
        registry.offerings.some((o) => o.provider === "openai" && o.family === "gpt-x"),
        listing,
      );
    }
  });

  it("OpenAI: credits a family its provider lists only as a dated snapshot — both date forms", () => {
    const base = fixture();
    for (const listing of ["gpt-x-20260101", "gpt-x-2026-01-01"]) {
      const { registry } = applyOpenAi(base, [listing], TODAY);
      assert.equal(
        registry.offerings.find((o) => o.provider === "openai" && o.family === "gpt-x")?.missingSince,
        undefined,
        listing,
      );
    }
    const { registry: gone } = applyOpenAi(base, ["something-else"], TODAY);
    assert.equal(
      gone.offerings.find((o) => o.provider === "openai" && o.family === "gpt-x")?.missingSince,
      TODAY,
    );
  });
});
