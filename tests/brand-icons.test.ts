import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findMissingBrandIcons, syncBrandIcons, type LobeIconEntry } from "../src/brand-icons.ts";

const SHA = "a".repeat(40);
const ICON_PATH = "packages/static-svg/icons/baai.svg";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const SVG_BYTES = Buffer.from(SVG);
const SVG_SHA = createHash("sha1").update(`blob ${SVG_BYTES.length}\0`).update(SVG_BYTES).digest("hex");

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
    const fetchFn = (async (url: string | URL | Request) => {
      const target = String(url);
      requests.push(target);
      if (target.endsWith("/lobehub/lobe-icons")) return new Response('{"default_branch":"master"}');
      if (target.endsWith("/commits/master")) return new Response(JSON.stringify({ sha: SHA }));
      if (target.includes("/git/trees/")) {
        const entry: LobeIconEntry = { path: ICON_PATH, type: "blob", sha: blobSha, size: SVG_BYTES.length };
        return new Response(JSON.stringify({ truncated: false, tree: [entry] }));
      }
      if (target.includes("raw.githubusercontent.com")) return new Response(SVG);
      throw new Error(`unexpected ${target}`);
    }) as typeof fetch;
    try {
      blobSha = "b".repeat(40);
      await assert.rejects(syncBrandIcons(root, fetchFn), /does not match its Git blob/);
      assert.equal(existsSync(join(icons, "baai.svg")), false);

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
