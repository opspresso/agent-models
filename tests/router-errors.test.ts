import assert from "node:assert/strict";
import { it } from "node:test";
import { RouterError, isRouterError } from "../src/domain/router/errors.ts";

it("recognizes another bundle's errors without trusting user-shaped objects", async () => {
  const separate = await import(new URL("../src/domain/router/errors.ts?separate-bundle", import.meta.url).href);
  const error = new separate.RouterError("request_already_exists", 409, "Already admitted");
  assert.equal(error instanceof RouterError, false);
  assert.equal(isRouterError(error), true);
  assert.equal(isRouterError({ name: "RouterError", code: "fake", status: 401, message: "untrusted" }), false);
  assert.equal(isRouterError(Object.assign(new Error("provider-secret"), { name: "RouterError", code: "fake", status: 400 })), false);
});
