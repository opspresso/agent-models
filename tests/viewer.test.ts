import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../docs/app.js", import.meta.url), "utf8");
const catalog = {
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
    capabilities: { tools: true, imageInput: false, reasoning: false },
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

function startViewer(iconResponse: Promise<Response>) {
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
      ? Promise.resolve(Response.json(catalog))
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
