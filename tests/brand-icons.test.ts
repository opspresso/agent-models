import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findMissingBrandIcons, isSafeBrandSvg, syncBrandIcons, type LobeIconEntry } from "../src/brand-icons.ts";

const SHA = "a".repeat(40);
const ICON_PATH = "packages/static-svg/icons/baai.svg";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const SVG_BYTES = Buffer.from(SVG);
const SVG_SHA = createHash("sha1").update(`blob ${SVG_BYTES.length}\0`).update(SVG_BYTES).digest("hex");
const NAMESPACED_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>';

describe("static brand SVG validation", () => {
  it("accepts every curated icon, including local gradients", () => {
    const directory = new URL("../docs/icons/brands/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".svg"))) {
      assert.equal(isSafeBrandSvg(readFileSync(new URL(file, directory), "utf8")), true, file);
    }
  });

  it("accepts static geometry, transforms, and quoted attributes", () => {
    assert.equal(isSafeBrandSvg(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
      <g transform='translate(1, 2) scale(.5)'><circle cx='12' cy='12' r='10' fill='rgb(10, 20, 30)' /></g>
    </svg>`), true);
  });

  const wrap = (content: string) => `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
  const unsafe: Record<string, string> = {
    script: wrap("<script>alert(1)</script>"),
    "prefixed script": NAMESPACED_SCRIPT,
    "foreign content": wrap('<foreignObject><iframe src="https://example.com"/></foreignObject>'),
    "root namespace override": '<svg xmlns="http://www.w3.org/1999/xhtml"/>',
    "child namespace override": wrap('<g xmlns="http://www.w3.org/1999/xhtml"/>'),
    "namespace declaration": '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    "duplicate attribute": '<svg xmlns="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/1999/xhtml"/>',
    "event handler": wrap('<path d="M0 0" onload="alert(1)"/>'),
    "external href": wrap('<path href="https://example.com"/>'),
    "external paint": wrap('<path fill="url(https://example.com/icon.svg#id)"/>'),
    "escaped paint": wrap('<path fill="u\\72l(https://example.com/icon.svg#id)"/>'),
    "external CSS": wrap('<path style="fill:url(https://example.com/icon.svg#id)"/>'),
    "escaped CSS": wrap('<path style="fill:u\\72l(https://example.com/icon.svg#id)"/>'),
    "CSS stylesheet": '<?xml-stylesheet href="https://example.com/style.css"?>' + SVG,
    "doctype entity": '<!DOCTYPE svg [<!ENTITY payload SYSTEM "https://example.com">]>' + wrap("<title>&payload;</title>"),
    "character entity": wrap('<path fill="&#117;rl(https://example.com/icon.svg#id)"/>'),
    "CDATA content": wrap("<![CDATA[<script>alert(1)</script>]]>"),
    "animated href": wrap('<animate attributeName="href" values="javascript:alert(1)"/>'),
    "set href": wrap('<set attributeName="href" to="javascript:alert(1)"/>'),
    "unconsumed attribute": wrap('<path fill="red" stray/>'),
    "unquoted attribute": wrap('<path fill=red/>'),
    "mismatched tags": wrap("<g></path>"),
    "unclosed tag": wrap("<g>"),
    "multiple roots": SVG + SVG,
    "nested svg": wrap(SVG),
    "trailing markup": SVG + "<script>alert(1)</script>",
    "trailing text": SVG + "junk",
    "markup in title": wrap("<title><g/></title>"),
    "unterminated markup": SVG + "<",
  };
  for (const [name, svg] of Object.entries(unsafe)) {
    it(`rejects ${name}`, () => assert.equal(isSafeBrandSvg(svg), false));
  }
});

describe("Lobe brand icon sync", () => {
  it("matches maker, vendor and display-name slugs exactly and skips existing icons", () => {
    const makers = {
      baai: { displayName: "BAAI" },
      mistralai: { displayName: "Mistral", openrouterVendor: "mistralai" },
      "fish-audio": { displayName: "Fish Audio", openrouterVendor: "fish-audio" },
      voyageai: { displayName: "VoyageAI by MongoDB", openrouterVendor: "voyageai" },
      typesafe: { displayName: "TypeSafe" },
    };
    const entries = ["baai", "mistral", "fishaudio", "voyage", "typesafe-color", "undefined"].map((slug) => ({
      path: `packages/static-svg/icons/${slug}.svg`, type: "blob", sha: SVG_SHA, size: SVG_BYTES.length,
    }));
    assert.deepEqual(
      findMissingBrandIcons(makers, new Set(["baai.svg"]), entries, { voyageai: "voyage" }).map(({ maker, source }) => [maker, source.path]),
      [["mistralai", "packages/static-svg/icons/mistral.svg"], ["fish-audio", "packages/static-svg/icons/fishaudio.svg"], ["voyageai", "packages/static-svg/icons/voyage.svg"]],
    );
  });

  it("pins and verifies upstream blobs before writing; dry runs leave files alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-models-icons-"));
    const base = join(root, "models");
    const icons = join(root, "docs", "icons", "brands");
    mkdirSync(join(base, "families"), { recursive: true });
    mkdirSync(join(base, "offerings"));
    mkdirSync(icons, { recursive: true });
    writeFileSync(join(base, "providers.json"), "[]");
    writeFileSync(join(base, "makers.json"), '{"baai":{"displayName":"BAAI"}}');
    const requests: string[] = [];
    let blobSha = SVG_SHA;
    let content = SVG;
    const fetchFn = (async (url: string | URL | Request) => {
      const target = String(url);
      requests.push(target);
      if (target.endsWith("/lobehub/lobe-icons")) return new Response('{"default_branch":"master"}');
      if (target.endsWith("/commits/master")) return new Response(JSON.stringify({ sha: SHA }));
      if (target.includes("/git/trees/")) {
        const entry: LobeIconEntry = { path: ICON_PATH, type: "blob", sha: blobSha, size: Buffer.byteLength(content) };
        return new Response(JSON.stringify({ truncated: false, tree: [entry] }));
      }
      if (target.includes("raw.githubusercontent.com")) return new Response(content);
      throw new Error(`unexpected ${target}`);
    }) as typeof fetch;
    try {
      blobSha = "b".repeat(40);
      await assert.rejects(syncBrandIcons(root, fetchFn), /does not match its Git blob/);
      assert.equal(existsSync(join(icons, "baai.svg")), false);

      content = NAMESPACED_SCRIPT;
      blobSha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
      await assert.rejects(syncBrandIcons(root, fetchFn), /not a safe SVG/);
      assert.equal(existsSync(join(icons, "baai.svg")), false);

      content = SVG;
      blobSha = SVG_SHA;
      assert.deepEqual(await syncBrandIcons(root, fetchFn, undefined, true), { upstreamSha: SHA, imported: ["baai"] });
      assert.equal(existsSync(join(icons, "baai.svg")), false);
      assert.deepEqual(await syncBrandIcons(root, fetchFn), { upstreamSha: SHA, imported: ["baai"] });
      assert.equal(readFileSync(join(icons, "baai.svg"), "utf8"), SVG);
      assert.ok(requests.some((url) => url.includes(`/${SHA}/${ICON_PATH}`)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
