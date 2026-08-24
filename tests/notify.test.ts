import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueBody, ISSUE_TITLE, slackMessage, syncIssue, type NotifyContext } from "../src/notify.ts";

const base: NotifyContext = { date: "2026-08-20", outcomes: [], runUrl: "https://example.test/run/1" };

describe("slackMessage", () => {
  it("says nothing on a quiet run", () => {
    assert.equal(slackMessage({ ...base, outcomes: [{ kind: "applied", result: { source: "OpenRouter", changes: [], notes: ["x: needs a look"] } }] }), null);
  });
  it("announces changes and failures, with the commit and run links", () => {
    const text = slackMessage({
      ...base,
      commitUrl: "https://example.test/commit/abc",
      outcomes: [
        { kind: "failed", source: "xAI", error: "boom" },
        { kind: "applied", result: { source: "OpenRouter", changes: [{ target: "family glm-5.3", field: "added", from: undefined, to: "GLM 5.3 via openrouter" }], notes: [] } },
      ],
    });
    assert.match(text ?? "", /xAI failed/);
    assert.match(text ?? "", /added family glm-5.3/);
    assert.match(text ?? "", /committed/);
    assert.match(text ?? "", /run>/);
  });
});

describe("issueBody", () => {
  it("is null when nothing needs a look, and lists notes and failures otherwise", () => {
    assert.equal(issueBody({ ...base, outcomes: [{ kind: "applied", result: { source: "OpenRouter", changes: [], notes: [] } }] }), null);
    const body = issueBody({
      ...base,
      outcomes: [
        { kind: "applied", result: { source: "OpenRouter", changes: [], notes: ["openrouter/x: not in OpenRouter's catalog"] } },
        { kind: "failed", source: "Google", error: "401" },
      ],
    });
    assert.match(body ?? "", /### OpenRouter\n\n- openrouter\/x/);
    assert.match(body ?? "", /### Google — failed/);
  });
});

describe("syncIssue", () => {
  it("ignores a pull request that carries the label and title", async () => {
    // GitHub's /issues listing returns PRs too; matching one by title would
    // comment on and "close" a pull request.
    const gh = fakeGitHub([{ number: 5, title: ISSUE_TITLE, body: "", pull_request: {} } as never]);
    await syncIssue(
      "t",
      "o/r",
      { ...base, outcomes: [{ kind: "failed", source: "xAI", error: "boom" }] },
      gh.fetchFn,
    );
    assert.ok(gh.calls.some((call) => call.method === "POST" && call.path === "/issues"));
    assert.ok(!gh.calls.some((call) => call.path.startsWith("/issues/5")));
  });

  function fakeGitHub(open: Array<{ number: number; title: string; body: string }>) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com/repos/o/r", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") return new Response(JSON.stringify(open), { status: 200 });
      if (method === "POST" && path === "/issues") return new Response(JSON.stringify({ number: 7 }), { status: 201 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it("opens an issue when something needs a look and none is open", async () => {
    const gh = fakeGitHub([]);
    const result = await syncIssue("t", "o/r", { ...base, outcomes: [{ kind: "applied", result: { source: "OpenRouter", changes: [], notes: ["a"] } }] }, gh.fetchFn);
    assert.equal(result, "opened #7");
    assert.ok(gh.calls.some((c) => c.method === "POST" && c.path === "/issues" && (c.body as { title: string }).title === ISSUE_TITLE));
  });

  it("rewrites the open issue when the list changed, and leaves it when it did not", async () => {
    const ctx = { ...base, outcomes: [{ kind: "applied" as const, result: { source: "OpenRouter", changes: [], notes: ["a"] } }] };
    const body = issueBody(ctx) as string;
    const same = fakeGitHub([{ number: 3, title: ISSUE_TITLE, body }]);
    assert.equal(await syncIssue("t", "o/r", ctx, same.fetchFn), "#3 unchanged");
    const stale = fakeGitHub([{ number: 3, title: ISSUE_TITLE, body: "old" }]);
    assert.equal(await syncIssue("t", "o/r", ctx, stale.fetchFn), "updated #3");
    assert.ok(stale.calls.some((c) => c.method === "PATCH" && c.path === "/issues/3"));
  });

  it("closes the issue the day the list is empty", async () => {
    const gh = fakeGitHub([{ number: 3, title: ISSUE_TITLE, body: "old" }]);
    assert.equal(await syncIssue("t", "o/r", base, gh.fetchFn), "closed #3");
    assert.ok(gh.calls.some((c) => c.method === "PATCH" && (c.body as { state: string }).state === "closed"));
  });
});
