import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "../src/registry.ts";
import { applyOpenRouter } from "../src/sources/openrouter.ts";
import { applyXai } from "../src/sources/xai.ts";
import { applyAnthropic, undated } from "../src/sources/anthropic.ts";
import { checkOpenAi } from "../src/sources/openai.ts";
import { perMillion } from "../src/sources/types.ts";

const TEXT = { tools: true, structuredOutput: true, imageInput: true, reasoning: true };

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
      { provider: "anthropic", family: "claude-y.1", wireId: "claude-y-1" },
      { provider: "openrouter", family: "gpt-x", wireId: "openai/gpt-x", pricing: { inputPer1M: 2.5, outputPer1M: 15, cachedInputPer1M: 0.25 } },
      { provider: "openrouter", family: "deepseek-z", wireId: "deepseek/deepseek-z", pricing: { inputPer1M: 0.0826, outputPer1M: 0.1652, cachedInputPer1M: 0.01652 } },
      { provider: "openrouter", family: "draw-1", wireId: "openai/draw-1" },
    ],
  };
}

describe("perMillion", () => {
  it("turns a per-token string into a per-million number without float noise", () => {
    assert.equal(perMillion(Number("0.0000000826")), 0.0826);
    assert.equal(perMillion(Number("0.000005")), 5);
    assert.equal(perMillion(Number("0.00000001652")), 0.01652);
  });
});

describe("applyOpenRouter", () => {
  it("lets a router-only family follow the catalog and drops the route's own override", () => {
    const { registry, result } = applyOpenRouter(fixture(), [
      {
        id: "deepseek/deepseek-z",
        context_length: 1_048_576,
        pricing: { prompt: "0.0000000826", completion: "0.0000001652", input_cache_read: "0.00000001652" },
        top_provider: { max_completion_tokens: 384_000 },
      },
    ]);
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
  });

  it("moves a router-only family's window and output cap with the catalog", () => {
    const { registry, result } = applyOpenRouter(fixture(), [
      {
        id: "deepseek/deepseek-z",
        context_length: 2_000_000,
        pricing: { prompt: "0.00000014", completion: "0.00000028", input_cache_read: "0.000000028" },
        top_provider: { max_completion_tokens: 400_000 },
      },
    ]);
    assert.equal(registry.families["deepseek-z"]!.contextWindow, 2_000_000);
    assert.equal(registry.families["deepseek-z"]!.maxTokens, 400_000);
    assert.ok(result.changes.some((c) => c.field === "contextWindow"));
  });

  it("refuses an output cap the catalog puts above the window", () => {
    const { registry, result } = applyOpenRouter(fixture(), [
      {
        id: "deepseek/deepseek-z",
        context_length: 100_000,
        pricing: { prompt: "0.00000014", completion: "0.00000028" },
        top_provider: { max_completion_tokens: 400_000 },
      },
    ]);
    assert.equal(registry.families["deepseek-z"]!.contextWindow, 100_000);
    assert.equal(registry.families["deepseek-z"]!.maxTokens, 384_000);
    assert.match(result.notes.join("\n"), /above the 100000 window/);
  });

  it("keeps a vendor family's numbers and sets the route override only while the router differs", () => {
    // Router now charges the vendor rate: the override goes.
    const agree = applyOpenRouter(fixture(), [
      { id: "openai/gpt-x", context_length: 1_050_000, pricing: { prompt: "0.000005", completion: "0.00003", input_cache_read: "0.0000005" } },
    ]);
    assert.deepEqual(agree.registry.families["gpt-x"]!.pricing, { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 0.5 });
    assert.equal(agree.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x")?.pricing, undefined);
    assert.equal(agree.result.changes.length, 1);
    assert.equal(agree.result.changes[0]?.to, undefined);

    // Router charges something else: the override follows the router, the family does not move.
    const differ = applyOpenRouter(fixture(), [
      { id: "openai/gpt-x", context_length: 1_050_000, pricing: { prompt: "0.000002", completion: "0.000012", input_cache_read: "0.0000002" } },
    ]);
    assert.deepEqual(differ.registry.families["gpt-x"]!.pricing, { inputPer1M: 5, outputPer1M: 30, cachedInputPer1M: 0.5 });
    assert.deepEqual(differ.registry.offerings.find((o) => o.provider === "openrouter" && o.family === "gpt-x")?.pricing, {
      inputPer1M: 2,
      outputPer1M: 12,
      cachedInputPer1M: 0.2,
    });
  });

  it("leaves an unchanged override alone and says nothing", () => {
    const { result } = applyOpenRouter(fixture(), [
      { id: "openai/gpt-x", context_length: 1_050_000, pricing: { prompt: "0.0000025", completion: "0.000015", input_cache_read: "0.00000025" } },
    ]);
    assert.deepEqual(result.changes, []);
  });

  it("reports a window the router disagrees on for a vendor family, without changing it", () => {
    const { registry, result } = applyOpenRouter(fixture(), [
      { id: "openai/gpt-x", context_length: 400_000, pricing: { prompt: "0.0000025", completion: "0.000015", input_cache_read: "0.00000025" } },
    ]);
    assert.equal(registry.families["gpt-x"]!.contextWindow, 1_050_000);
    assert.match(result.notes.join("\n"), /states a 400000 window/);
  });

  it("reports a route the catalog no longer lists and leaves it as it is", () => {
    const { registry, result } = applyOpenRouter(fixture(), []);
    assert.deepEqual(registry.offerings, fixture().offerings);
    assert.match(result.notes.join("\n"), /openrouter\/gpt-x: not in OpenRouter's catalog/);
    assert.match(result.notes.join("\n"), /openrouter\/deepseek-z: not in OpenRouter's catalog/);
  });

  it("does not price an image model from the token catalog", () => {
    const { registry, result } = applyOpenRouter(fixture(), [
      { id: "openai/draw-1", context_length: 400_000, pricing: { prompt: "0.000005", completion: "0.00001" } },
    ]);
    assert.deepEqual(registry.families["draw-1"], fixture().families["draw-1"]);
    assert.deepEqual(result.changes, []);
  });

  it("looks an image model up in the image catalog before calling it missing", () => {
    const listed = applyOpenRouter(fixture(), [], ["openai/draw-1"]);
    assert.ok(!listed.result.notes.some((n) => n.includes("openrouter/draw-1")));
    const unlisted = applyOpenRouter(fixture(), [], []);
    assert.match(unlisted.result.notes.join("\n"), /openrouter\/draw-1: in neither of OpenRouter's catalogs/);
  });

  it("does not mutate the registry it was given", () => {
    const input = fixture();
    applyOpenRouter(input, [
      { id: "deepseek/deepseek-z", context_length: 10, pricing: { prompt: "0.001", completion: "0.002" } },
    ]);
    assert.deepEqual(input, fixture());
  });
});

describe("applyXai", () => {
  it("reads 1e-10 USD ticks as USD per million and matches through aliases", () => {
    const { registry, result } = applyXai(fixture(), [
      {
        id: "grok-q-0309-reasoning",
        aliases: ["grok-q"],
        prompt_text_token_price: 12_500,
        cached_prompt_text_token_price: 2_000,
        completion_text_token_price: 25_000,
      },
    ]);
    assert.deepEqual(registry.families["grok-q"]!.pricing, { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 });
    assert.equal(result.changes.length, 1);
    assert.deepEqual(result.notes, []);
  });

  it("skips a hidden route rather than reporting it missing every day", () => {
    const { result } = applyXai(fixture(), [
      { id: "grok-q", prompt_text_token_price: 20_000, cached_prompt_text_token_price: 3_000, completion_text_token_price: 60_000 },
    ]);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.notes, []);
  });

  it("reports a live route the catalog does not list", () => {
    const { result } = applyXai(fixture(), []);
    assert.deepEqual(result.notes, ["xai/grok-q: not in xAI's language-models catalog"]);
  });
});

describe("applyAnthropic", () => {
  it("strips a dated snapshot to its alias", () => {
    assert.equal(undated("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.equal(undated("claude-opus-5"), "claude-opus-5");
  });

  it("moves the family's window and output cap from the catalog, matched on the wire id", () => {
    const { registry, result } = applyAnthropic(fixture(), [
      { id: "claude-y-1-20260101", max_input_tokens: 1_000_000, max_tokens: 128_000 },
    ]);
    assert.equal(registry.families["claude-y.1"]!.contextWindow, 1_000_000);
    assert.equal(registry.families["claude-y.1"]!.maxTokens, 128_000);
    assert.equal(result.changes.length, 2);
  });

  it("prefers the undated id when the catalog lists both", () => {
    const { registry } = applyAnthropic(fixture(), [
      { id: "claude-y-1-20260101", max_input_tokens: 200_000, max_tokens: 64_000 },
      { id: "claude-y-1", max_input_tokens: 1_000_000, max_tokens: 128_000 },
    ]);
    assert.equal(registry.families["claude-y.1"]!.contextWindow, 1_000_000);
  });

  it("reports a missing model and an entry without limits", () => {
    assert.deepEqual(applyAnthropic(fixture(), []).result.notes, ["anthropic/claude-y.1: not in Anthropic's models catalog"]);
    assert.deepEqual(applyAnthropic(fixture(), [{ id: "claude-y-1" }]).result.notes, [
      "anthropic/claude-y.1: catalog entry carries no limits",
    ]);
  });
});

describe("checkOpenAi", () => {
  it("only reports, and only live routes", () => {
    const result = checkOpenAi(fixture(), ["draw-1"]);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.notes, ["openai/gpt-x: not in OpenAI's models catalog"]);
  });
});
