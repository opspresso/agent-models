import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(resolve(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []);
}

it("keeps domain pure and infrastructure independent of application and presentation", () => {
  const violations: string[] = [];
  for (const file of files(source)) {
    const layer = relative(source, file).split("/")[0];
    for (const match of readFileSync(file, "utf8").matchAll(/^import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm)) {
      const specifier = match[1]!;
      const target = specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined;
      const targetLayer = target ? relative(source, target).split("/")[0] : undefined;
      if (layer === "domain" && targetLayer !== "domain") violations.push(`${relative(source, file)} → ${specifier}`);
      if (layer === "infrastructure" && ["application", "lib", "app"].includes(targetLayer ?? "")) violations.push(`${relative(source, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
