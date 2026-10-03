import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Catalog, ModelCapabilities, ModelPricing } from "../src/registry.ts";

const source = readFileSync(new URL("../docs/app.js", import.meta.url), "utf8");
const catalog: Catalog = {
  version: 1,
  source: "https://example.com/models",
  updatedAt: "2026-10-03T00:00:00.000Z",
  providers: ["maker"],
  makers: { maker: "Model Maker" },
  models: ["Alpha", "Beta"].map((name) => ({
    id: `maker/${name.toLowerCase()}`,
    family: `maker/${name.toLowerCase()}`,
    displayName: name,
    maker: "maker",
    provider: "maker",
    pricing: { inputPer1M: 1, outputPer1M: 2 },
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
    contextWindow: 1000,
    maxTokens: 100,
  })),
};

class Element {
  innerHTML = "";
  #textContent = "";
  get textContent() { return this.#textContent; }
  set textContent(value: string | number) { this.#textContent = String(value); }
  value = "";
  listeners = new Map<string, (event: { target: Element }) => void>();
  classList = { add() {}, remove() {}, toggle() {} };
  addEventListener(name: string, listener: (event: { target: Element }) => void) { this.listeners.set(name, listener); }
  append() {}
  querySelectorAll() { return []; }
}

function startViewer(iconResponse: Promise<Response>, models = catalog.models) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const errors: unknown[][] = [];
  const complete: Promise<void> = runInNewContext(source, {
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      createElement: () => new Element(),
    },
    localStorage: { getItem: () => null, setItem() {} },
    console: { error: (...args: unknown[]) => errors.push(args) },
    fetch: (url: string) => url === "models.json"
      ? Promise.resolve(Response.json({ ...catalog, models }))
      : iconResponse,
  });
  return { element, errors, complete };
}

test("the catalog and filters work while icons are pending, and late icons preserve the filter", async () => {
  let resolveIcons!: (response: Response) => void;
  const icons = new Promise<Response>((resolve) => { resolveIcons = resolve; });
  const viewer = startViewer(icons);
  await setImmediate();
  assert.equal(viewer.element("n-models").textContent, "2");
  assert.match(viewer.element("grid").innerHTML, />Alpha</);
  assert.match(viewer.element("grid").innerHTML, />Beta</);
  assert.match(viewer.element("grid").innerHTML, /class="mark initials"/);

  const search = viewer.element("q");
  search.value = "beta";
  search.listeners.get("input")!({ target: search });
  assert.doesNotMatch(viewer.element("grid").innerHTML, />Alpha</);
  assert.equal(viewer.element("count").textContent, "1 model");

  resolveIcons(Response.json({ maker: "maker.svg" }));
  await viewer.complete;
  assert.match(viewer.element("grid").innerHTML, /src="icons\/brands\/maker\.svg"/);
  assert.doesNotMatch(viewer.element("grid").innerHTML, />Alpha</);
  assert.match(viewer.element("grid").innerHTML, />Beta</);
  assert.deepEqual(viewer.errors, []);
});

test("failed icon requests leave the usable catalog with initials", async () => {
  const viewer = startViewer(Promise.reject(new Error("icon connection failed")));
  await viewer.complete;
  assert.match(viewer.element("grid").innerHTML, /class="mark initials"/);
  assert.equal(viewer.element("count").textContent, "2 models");
  assert.equal(viewer.errors.length, 1);
  assert.equal(viewer.errors[0]?.[0], "Could not load brand icons");
});

const priceCases: { name: string; pricing: ModelPricing; capabilities: Partial<ModelCapabilities>; current: string; list: string }[] = [
  { name: "flat image", pricing: { inputPer1M: 0, outputPer1M: 0, perImage: 0.02 }, capabilities: { imageGeneration: true }, current: "$0.02 / image", list: "$0.04 / image" },
  { name: "estimated image", pricing: { inputPer1M: 1, outputPer1M: 0, imageOutputPer1M: 20, perImage: 0.04 }, capabilities: { imageGeneration: true }, current: "≈$0.04 / image · $1.00 in per 1M", list: "≈$0.08 / image · $2.00 in per 1M" },
  { name: "image tokens", pricing: { inputPer1M: 0, outputPer1M: 0, imageOutputPer1M: 20 }, capabilities: { imageGeneration: true }, current: "$20.00 image out per 1M", list: "$40.00 image out per 1M" },
  { name: "text tokens", pricing: { inputPer1M: 1, outputPer1M: 2 }, capabilities: {}, current: "$1.00 in · $2.00 out per 1M", list: "$2.00 in · $4.00 out per 1M" },
  { name: "rerank search", pricing: { inputPer1M: 0, outputPer1M: 0, perSearch: 0.001 }, capabilities: { rerank: true }, current: "$0.0010 / search", list: "$0.0020 / search" },
  { name: "audio minute", pricing: { inputPer1M: 0, outputPer1M: 0, perAudioMinute: 0.006 }, capabilities: { transcription: true }, current: "$0.0060 / audio minute", list: "$0.01 / audio minute" },
];
for (const fixture of priceCases) {
  test(`discounted ${fixture.name} prices preserve their unit and restore the list rate`, async () => {
    const base = catalog.models[0]!;
    const model = { ...base, pricing: { ...fixture.pricing, discount: 0.5 }, capabilities: { ...base.capabilities, ...fixture.capabilities } };
    const viewer = startViewer(Promise.resolve(Response.json({})), [model]);
    await viewer.complete;
    const card = viewer.element("grid").innerHTML;
    assert.ok(card.includes(`<div class="price"><span>${fixture.current}</span>`));
    assert.ok(card.includes(`50% off — list ${fixture.list}"`));
  });
}
