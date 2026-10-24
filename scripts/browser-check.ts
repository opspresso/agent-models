import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { oauthProvider, getOAuthProviderApi } from "@better-auth/oauth-provider";
import { createAuthEndpoint } from "better-auth/api";
import { chromium, type Page } from "@playwright/test";
import { z } from "zod";
import { MODEL_SCOPES, MODELS_RESOURCE, PLATFORM_IDENTITY_CLAIM, PLATFORM_SERVICE_CLAIM, PLATFORM_MODEL_CALL_CLAIM, SIGN_IN_SCOPES } from "../src/domain/identity.ts";

const database = process.env.DATABASE_URL;
if (!database) throw new Error("DATABASE_URL must name a local disposable *_test database");
const target = new Client({ connectionString: database });
if (!["localhost", "127.0.0.1"].includes(target.host) || !target.database?.endsWith("_test")) throw new Error("Refusing a non-local or non-test database");
const suffix = randomUUID().replaceAll("-", "");
const schema = `models_browser_${suffix}`;
const prefix = `fixture_${suffix.slice(0, 8)}_`;
const owner = new Pool({ connectionString: database });
const scopedUrl = new URL(database);
scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
const pool = new Pool({ connectionString: scopedUrl.toString(), max: 8 });
const directory = await mkdtemp(join(tmpdir(), "agent-models-browser-"));
let child: ReturnType<typeof spawn> | undefined;
let childExit: Promise<unknown> | undefined;
let output = "";
let handleAuth: ((request: Request) => Promise<Response>) | undefined;
let issuerOrigin = "";
let providerCalls = 0;
let providerFailure: unknown;
let refreshes = 0;
const issuedUserTokens = new Set<string>();

const server = httpServer(async (request, response) => {
  try {
    const url = new URL(request.url!, issuerOrigin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (url.pathname === "/provider/v1/models") {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return;
    }
    if (url.pathname === "/provider/v1/chat/completions") {
      providerCalls++;
      assert.equal(request.headers.authorization, "Bearer browser-fixture-provider-key");
      const body = JSON.parse(bytes.toString());
      assert.equal(body.model, "fixture-model");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "fixture-completion", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })); return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    assert.ok(handleAuth);
    const result = await handleAuth(new Request(url, { method: request.method!, headers,
      ...(!["GET", "HEAD"].includes(request.method!) ? { body: new Uint8Array(bytes) } : {}) }));
    if (url.pathname === "/api/auth/oauth2/token" && result.ok) {
      const grant = new URLSearchParams(bytes.toString()).get("grant_type");
      if (grant === "refresh_token") refreshes++;
      if (grant === "refresh_token" || grant === "authorization_code") issuedUserTokens.add((await result.clone().json()).access_token);
    }
    response.statusCode = result.status;
    for (const [name, value] of result.headers) if (name !== "set-cookie") response.setHeader(name, value);
    if (result.headers.getSetCookie().length) response.setHeader("set-cookie", result.headers.getSetCookie());
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { providerFailure = error; response.statusCode = 500; response.end("Fixture request failed"); }
});

async function main() {
  await owner.query(`CREATE SCHEMA "${schema}"`);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string"); issuerOrigin = `http://127.0.0.1:${address.port}`;
  const issuer = `${issuerOrigin}/api/auth`;
  const provider = oauthProvider({ loginPage: "/login", consentPage: "/consent", scopes: [...new Set([...SIGN_IN_SCOPES, ...MODEL_SCOPES])],
    grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
    clientPrivileges: ({ user }) => user?.tier === "admin", resourcePrivileges: ({ user }) => user?.tier === "admin",
    customUserInfoClaims: ({ user }) => ({ [PLATFORM_IDENTITY_CLAIM]: { version: 1, userId: user.id, tier: user.tier, admin: user.tier === "admin", canRunAgents: user.tier !== "guest" } }),
    customAccessTokenClaims: ({ user, metadata }) => ({ ...(user ? { [PLATFORM_IDENTITY_CLAIM]: { version: 1, userId: user.id, tier: user.tier, admin: user.tier === "admin", canRunAgents: user.tier !== "guest" } } : {}),
      [PLATFORM_SERVICE_CLAIM]: { id: metadata?.service, principal: user ? "user" : "service" } }),
  });
  const mappedSchema = Object.fromEntries(Object.keys(provider.schema).map(key => [key, { modelName: prefix + key }]));
  const issuerPlugin = oauthProvider({ ...provider.options, schema: mappedSchema });
  const options = { database: pool, baseURL: issuerOrigin, secret: randomUUID() + randomUUID(),
    user: { modelName: prefix + "user", additionalFields: { tier: { type: "string" as const, input: false, defaultValue: "admin" } } },
    session: { modelName: prefix + "session" }, account: { modelName: prefix + "account" }, verification: { modelName: prefix + "verification" },
    advanced: { cookiePrefix: "agent-studio" }, emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer }, disableSettingJwtHeader: true, jwks: { keyPairConfig: { alg: "RS256" as const } }, schema: { jwks: { modelName: prefix + "jwks" } } }),
      // The SDK's generated OpenAPI metadata types include optional undefined fields.
      // Keep the native endpoint types while acknowledging its runtime plugin contract.
      issuerPlugin as typeof issuerPlugin & BetterAuthPlugin,
      { id: "fixture-call-grants", endpoints: { issueFixtureModelCall: createAuthEndpoint.serverOnly({
        method: "POST", body: z.object({ userId: z.string(), clientId: z.string() }),
      }, async ctx => {
        const capability = getOAuthProviderApi(ctx, { ...issuerPlugin.options, accessTokenExpiresIn: 60 }, "urn:fixture:model-call");
        const targetClient = await capability.getClient(ctx.body.clientId);
        const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        assert.ok(targetClient && user);
        return capability.issueTokens({ client: targetClient, user, scopes: ["openid", "platform:identity", "models:invoke", "usage:read"], resources: [MODELS_RESOURCE],
          accessTokenClaims: { [PLATFORM_MODEL_CALL_CLAIM]: { version: 1, requestId: "delegated-call", modelId: "local/fixture-model", operation: "chat/completions", agentId: "verified-agent" } } });
      }), issueFixtureSenderBoundToken: createAuthEndpoint.serverOnly({
        method: "POST", body: z.object({ clientId: z.string(), kind: z.enum(["dpop", "mtls"]) }),
      }, async ctx => {
        const capability = getOAuthProviderApi(ctx, issuerPlugin.options, "urn:fixture:sender-bound");
        const targetClient = await capability.getClient(ctx.body.clientId);
        assert.ok(targetClient);
        // Simulate proof verified by the issuer. The resource server receives no such proof.
        const thumbprint = Buffer.alloc(32, 9).toString("base64url");
        return capability.issueTokens({ client: targetClient, scopes: ["models:read"], resources: [MODELS_RESOURCE],
          confirmation: ctx.body.kind === "dpop" ? { jkt: thumbprint } : { "x5t#S256": thumbprint } });
      }) } }],
  };
  const migration = await getMigrations(options);
  assert.equal(migration.toBeAdded.length, 0);
  assert.ok(migration.toBeCreated.every(table => table.table.startsWith(prefix)), "fixture migrations cannot target another service");
  await migration.runMigrations();
  const auth = betterAuth(options); handleAuth = request => auth.handler(request);
  const signed = await auth.handler(new Request(`${issuer}/sign-up/email`, { method: "POST", headers: { origin: issuerOrigin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Fixture Admin", email: "models-admin@example.test", password: "browser-fixture-password" }) }));
  assert.equal(signed.status, 200);
  const cookie = signed.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const adminHeaders = new Headers({ cookie, origin: issuerOrigin });
  const adminUser = z.object({ user: z.object({ id: z.string() }) }).parse(await signed.json()).user;
  assert.ok(auth.api.adminCreateOAuthResource && auth.api.adminCreateOAuthClient && auth.api.adminLinkClientResource);
  await auth.api.adminCreateOAuthResource({ headers: adminHeaders, body: { identifier: MODELS_RESOURCE, name: "Agent Models", allowedScopes: [...new Set([...SIGN_IN_SCOPES, ...MODEL_SCOPES])], accessTokenTtl: 300 } });
  const reservation = netServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const allocated = reservation.address(); assert.ok(allocated && typeof allocated !== "string"); const port = allocated.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const client = z.object({ client_id: z.string(), client_secret: z.string().min(1) }).parse(await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: { client_name: "Agent Models", application_type: "native",
    redirect_uris: [`${origin}/api/auth/callback/studio`], scope: SIGN_IN_SCOPES.join(" "), grant_types: ["authorization_code", "refresh_token", "client_credentials"],
    client_credentials_scopes: ["models:read", "usage:read"], skip_consent: true, require_pkce: true, token_endpoint_auth_method: "client_secret_post", metadata: { service: "agent-models" } } }));
  assert.ok(client.client_secret);
  await auth.api.adminLinkClientResource({ headers: adminHeaders, params: { identifier: MODELS_RESOURCE, client_id: client.client_id } });
  const machineClient = z.object({ client_id: z.string(), client_secret: z.string() }).parse(await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
    body: { client_name: "Agent Forge", grant_types: ["client_credentials"], token_endpoint_auth_method: "client_secret_post",
      client_credentials_scopes: ["models:read", "models:invoke", "usage:read", "usage:receipts"], scope: MODEL_SCOPES.join(" "), metadata: { service: "agent-forge" } } }));
  await auth.api.adminLinkClientResource({ headers: adminHeaders, params: { identifier: MODELS_RESOURCE, client_id: machineClient.client_id } });
  async function machineToken(scope: string) {
    const response = await fetch(`${issuer}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      grant_type: "client_credentials", client_id: machineClient.client_id, client_secret: machineClient.client_secret, scope, resource: MODELS_RESOURCE,
    }) });
    assert.equal(response.status, 200);
    return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
  }
  await cp(".next/standalone", directory, { recursive: true, verbatimSymlinks: true });
  await cp(".next/static", join(directory, ".next/static"), { recursive: true });
  await cp("public", join(directory, "public"), { recursive: true });
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) await rm(join(directory, name), { force: true });
  child = spawn(process.execPath, ["server.js"], { cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port),
    DATABASE_URL: scopedUrl.toString(), AES_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), AUTH_BASE_URL: origin, AUTH_SECRET: "models-browser-fixture-secret-with-32-characters",
    OIDC_ISSUER: issuer, OIDC_CLIENT_ID: client.client_id, OIDC_CLIENT_SECRET: client.client_secret, OIDC_PROVIDER_ID: "studio" }, stdio: ["ignore", "pipe", "pipe"] });
  childExit = once(child, "exit");
  for (const pipe of [child.stdout, child.stderr]) pipe?.on("data", chunk => { output = (output + chunk).slice(-16_384); });
  const deadline = Date.now() + 60_000;
  while (true) {
    assert.equal(child.exitCode, null, `Models server exited: ${output}`);
    try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break; }
    catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error; }
    assert.ok(Date.now() < deadline, `Models server did not become ready: ${output}`); await delay(100);
  }
  const coldPage = await fetch(`${origin}/login`);
  assert.equal(coldPage.status, 200); await coldPage.text();
  assert.equal((await fetch(`${origin}/api/ready`)).status, 200);
  assert.equal((await fetch(`${origin}/api/models`)).status, 401);
  assert.equal((await fetch(`${origin}/models.json`)).status, 200);
  const browser = await chromium.launch({ headless: true });
  let page: Page | undefined;
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ locale: "en", viewport: { width: 1365, height: 1000 } });
    await context.addCookies(signed.headers.getSetCookie().map(value => { const part = value.split(";")[0]!; const index = part.indexOf("="); return { name: part.slice(0, index), value: part.slice(index + 1), url: issuerOrigin }; }));
    page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Sign in with Studio", exact: true }).click();
    await page.getByRole("heading", { name: "Selected models", exact: true }).waitFor();
    assert.ok(!(await page.content()).includes(client.client_secret));
    await page.getByRole("link", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel(new RegExp("^ID(?:\\s*\\*)?$")).fill("local"); await dialog.getByLabel(new RegExp("^Name(?:\\s*\\*)?$")).fill("Fixture provider");
    await dialog.getByLabel(new RegExp("^Provider\\ type(?:\\s*\\*)?$")).click(); await page.getByRole("option", { name: "selfhosted", exact: true }).click();
    await dialog.getByLabel(new RegExp("^API\\ base\\ URL(?:\\s*\\*)?$")).fill(`${issuerOrigin}/provider/v1`); await dialog.getByLabel(new RegExp("^API\\ key(?:\\s*\\*)?$")).fill("browser-fixture-provider-key");
    await dialog.getByRole("button", { name: "Save", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Selected models", exact: true }).click(); await page.getByRole("tab", { name: "Discovered models", exact: true }).click();
    await page.getByRole("button", { name: "Collect models", exact: true }).click();
    await page.getByRole("button", { name: "Select model", exact: true }).click(); dialog = page.getByRole("dialog");
    await dialog.getByLabel(new RegExp("^Model\\ type(?:\\s*\\*)?$")).click(); await page.getByRole("option", { name: "text", exact: true }).click();
    await dialog.getByLabel(new RegExp("^Context\\ window(?:\\s*\\*)?$")).fill("8192"); await dialog.getByLabel(new RegExp("^Maximum\\ output\\ tokens(?:\\s*\\*)?$")).fill("1024");
    await dialog.getByRole("button", { name: "Pricing", exact: true }).click(); await dialog.getByLabel(new RegExp("^Pricing\\ is\\ known(?:\\s*\\*)?$")).check();
    await dialog.getByLabel(new RegExp("^Input\\ /\\ 1M\\ tokens(?:\\s*\\*)?$")).fill("2"); await dialog.getByLabel(new RegExp("^Output\\ /\\ 1M\\ tokens(?:\\s*\\*)?$")).fill("6");
    await dialog.getByRole("button", { name: "Save", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
    const catalog = await page.request.get(`${origin}/v1/models`);
    assert.equal(catalog.headers()["x-model-binding-revisions"], "1");
    const selected = (await catalog.json()).data[0];
    const bindingHeaders = { "x-model-revision": String(selected.revision), "x-provider-revision": String(selected.providerRevision), "x-model-binding": selected.binding };
    for (const [headers, status] of [
      [{ "x-model-revision": "1" }, 400],
      [{ ...bindingHeaders, "x-model-binding": "invalid" }, 400],
      [{ ...bindingHeaders, "x-provider-revision": String(selected.providerRevision + 1) }, 409],
      [{ ...bindingHeaders, "x-model-binding": "0".repeat(64) }, 409],
    ] as const) {
      assert.equal((await page.request.post(`${origin}/v1/chat/completions`, { headers: { origin, ...headers }, data: { model: selected.id, messages: [] } })).status(), status);
    }
    assert.equal(providerCalls, 0, "invalid or stale bindings never reach the provider");
    const call = await page.request.post(`${origin}/v1/chat/completions`, { headers: { origin, ...bindingHeaders, "idempotency-key": "browser-model-call" }, data: { model: "local/fixture-model", messages: [{ role: "user", content: "Reply with OK" }] } });
    assert.equal(call.status(), 200); assert.equal((await call.json()).choices[0].message.content, "OK");
    assert.equal(call.headers()["x-request-id"], "browser-model-call");
    for (const [name, value] of Object.entries(bindingHeaders)) assert.equal(call.headers()[name], value);
    assert.equal((await page.request.post(`${origin}/v1/chat/completions`, { headers: { origin, "idempotency-key": "browser-model-call" }, data: { model: "local/fixture-model", messages: [] } })).status(), 409);
    assert.equal(providerCalls, 1);
    const usage = await page.request.get(`${origin}/api/usage/agent-models/browser-model-call`);
    assert.equal(usage.status(), 200); const receipt = await usage.json();
    assert.equal(receipt.subject, adminUser.id); assert.equal(receipt.settlement.costUsd, 0.000032);
    const providerView = await page.request.get(`${origin}/api/providers`); assert.ok(!(await providerView.text()).includes("browser-fixture-provider-key"));
    const storedAccount = (await pool.query('SELECT "accessToken" FROM agent_models_account LIMIT 1')).rows[0];
    assert.ok(issuedUserTokens.size > 0, "the issuer fixture observed the browser's token exchange");
    assert.ok(!issuedUserTokens.has(storedAccount.accessToken), "OIDC access tokens are encrypted at rest");
    await pool.query('UPDATE agent_models_account SET "accessTokenExpiresAt"=now()-interval \'1 second\'');
    const refreshedRequests = await Promise.all(Array.from({ length: 6 }, () => page!.request.get(`${origin}/api/models`)));
    assert.ok(refreshedRequests.every(response => response.status() === 200));
    assert.equal(refreshes, 1, "concurrent requests rotate the refresh token once");
    const serviceToken = await machineToken("models:read models:invoke usage:read");
    assert.equal((await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${serviceToken}` } })).status, 200);
    assert.ok(auth.api.issueFixtureSenderBoundToken);
    for (const kind of ["dpop", "mtls"] as const) {
      const bound: { token_type: string; access_token: string } = await auth.api.issueFixtureSenderBoundToken({ body: { clientId: machineClient.client_id, kind } });
      assert.equal(bound.token_type, kind === "dpop" ? "DPoP" : "Bearer");
      assert.equal((await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${bound.access_token}` } })).status, 401,
        "sender-constrained service credentials cannot be replayed as unbound Bearer tokens");
    }
    const serviceCall = await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json", "idempotency-key": "machine-call", "x-user-id": adminUser.id, "x-agent-id": "forged-agent" }, body: JSON.stringify({ model: "local/fixture-model", messages: [] }) });
    assert.equal(serviceCall.status, 200); assert.equal(serviceCall.headers.get("x-model-dispatch"), "started"); await serviceCall.json();
    const serviceUsage = await (await page.request.get(`${origin}/api/usage/agent-forge/machine-call`)).json();
    assert.equal(serviceUsage.subject, "service:agent-forge"); assert.equal(serviceUsage.agentId, null);
    const readOnly = await machineToken("models:read");
    const refused = await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${readOnly}`, "content-type": "application/json" }, body: JSON.stringify({ model: "local/fixture-model", messages: [] }) });
    assert.equal(refused.status, 403); assert.equal(refused.headers.get("x-model-dispatch"), "not_started");
    const pieces = serviceToken.split("."); pieces[2] = (pieces[2]!.startsWith("A") ? "B" : "A") + pieces[2]!.slice(1);
    assert.equal((await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${pieces.join(".")}` } })).status, 401);
    assert.ok(auth.api.issueFixtureModelCall);
    const delegated = await auth.api.issueFixtureModelCall({ body: { userId: adminUser.id, clientId: machineClient.client_id } });
    const delegatedHeaders = { authorization: `Bearer ${delegated.access_token}`, "content-type": "application/json", "idempotency-key": "delegated-call", "x-agent-id": "forged-agent" };
    for (const [id, model, operation] of [["other-call", "local/fixture-model", "chat/completions"], ["delegated-call", "other-model", "chat/completions"], ["delegated-call", "local/fixture-model", "responses"]]) {
      assert.equal((await fetch(`${origin}/v1/${operation}`, { method: "POST", headers: { ...delegatedHeaders, "idempotency-key": id! }, body: JSON.stringify({ model, messages: [] }) })).status, 403);
    }
    assert.equal(providerCalls, 2);
    const delegatedResponse = await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: delegatedHeaders, body: JSON.stringify({ model: "local/fixture-model", messages: [] }) });
    assert.equal(delegatedResponse.status, 200); await delegatedResponse.json();
    const delegatedReceipt = await (await fetch(`${origin}/api/usage/agent-forge/delegated-call`, { headers: delegatedHeaders })).json();
    assert.equal(delegatedReceipt.subject, adminUser.id); assert.equal(delegatedReceipt.agentId, "verified-agent");
    assert.equal((await fetch(`${origin}/api/usage/agent-models/browser-model-call`, { headers: delegatedHeaders })).status, 404, "a call grant cannot read another receipt even for the same user");
    assert.equal((await fetch(`${origin}/api/usage?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`, { headers: delegatedHeaders })).status, 403);
    assert.equal((await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: delegatedHeaders, body: JSON.stringify({ model: "local/fixture-model", messages: [] }) })).status, 409);
    const receiptToken = await machineToken("usage:receipts");
    const receiptHeaders = { authorization: `Bearer ${receiptToken}` };
    assert.equal((await fetch(`${origin}/api/usage/agent-forge/delegated-call`, { headers: receiptHeaders })).status, 200, "a service recovers its user's completed receipt independently of the per-call token");
    assert.equal((await fetch(`${origin}/api/usage/agent-models/browser-model-call`, { headers: receiptHeaders })).status, 404, "receipt authority is restricted to the issuing service");
    assert.equal((await fetch(`${origin}/api/usage?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`, { headers: receiptHeaders })).status, 403);
    assert.equal((await fetch(`${origin}/v1/models`, { headers: receiptHeaders })).status, 403);
    assert.equal((await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { ...receiptHeaders, "content-type": "application/json" }, body: JSON.stringify({ model: "local/fixture-model", messages: [] }) })).status, 403);
    assert.ok(auth.api.deleteOAuthClient);
    await auth.api.deleteOAuthClient({ headers: adminHeaders, body: { client_id: machineClient.client_id } });
    assert.equal((await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${serviceToken}` } })).status, 401);
    assert.equal((await fetch(`${origin}/api/usage/agent-forge/delegated-call`, { headers: delegatedHeaders })).status, 401, "client revocation also invalidates a delegated user grant");
    await page.getByRole("link", { name: "Usage", exact: true }).click(); await page.getByText("local/fixture-model", { exact: true }).waitFor();
    await mkdir("test-results", { recursive: true }); await page.screenshot({ path: "test-results/models-usage-en.png", fullPage: true });
    await page.getByRole("button", { name: "Switch language" }).click(); await page.getByRole("heading", { name: "사용량", exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 900 });
    assert.ok(await page.locator("body").evaluate(body => body.scrollWidth <= window.innerWidth), "mobile page has no horizontal overflow");
    await page.screenshot({ path: "test-results/models-usage-ko-mobile.png", fullPage: true });
    await pool.query(`UPDATE "${prefix}user" SET tier='guest' WHERE id=$1`, [adminUser.id]);
    assert.equal((await page.request.get(`${origin}/api/providers`)).status(), 403, "central role changes apply without a new RP login");
    assert.equal((await page.request.post(`${origin}/v1/chat/completions`, { headers: { origin }, data: { model: "local/fixture-model", messages: [] } })).status(), 403);
    assert.equal(providerCalls, 3);
    assert.equal((await page.request.get(`${origin}/api/usage/agent-forge/machine-call`)).status(), 404, "a non-admin cannot read service-owned usage");
    assert.equal((await page.request.post(`${origin}/api/auth/get-access-token`, { headers: { origin }, data: { accountId: "irrelevant" } })).status(), 404);
    assert.deepEqual(errors, []);
    assert.equal(providerFailure, undefined);
    await context.close();
    console.log("PASS Models browser: OIDC code flow, encrypted/single refresh, provider/discovery/selection, actual model HTTP, signed per-call user/agent grants, scope/signature/client/role revocation, no replay and English/Korean mobile UI");
  } catch (error) {
    await mkdir("test-results", { recursive: true });
    if (page) {
      await page.screenshot({ path: "test-results/models-failure.png", fullPage: true });
      console.error(JSON.stringify({ path: new URL(page.url()).pathname, errors, screen: (await page.locator("body").innerText()).slice(0, 5000) }));
    }
    throw error;
  } finally { await browser.close(); }
}

try { await main(); }
finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (childExit) await childExit;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
  await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await owner.end(); await rm(directory, { recursive: true, force: true });
}
