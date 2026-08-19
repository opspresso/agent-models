/**
 * Where the update's findings go, beyond the job summary nobody opens.
 *
 * Two channels with two jobs. **Slack** carries *events*: the run changed
 * something (a price, a route added, a model retired) or a source could not be
 * read — posted once per run that has one, so a quiet day is quiet. The
 * **GitHub issue** carries *state*: one rolling issue holding everything that
 * needs a person (an unknown maker, a window a router disagrees on, an absence
 * being counted down), rewritten each run and closed the day the list is
 * empty — so nobody has to diff yesterday's summary against today's.
 */

import type { SourceOutcome } from "./report.ts";
import type { Change } from "./sources/types.ts";

export const ISSUE_TITLE = "Model registry: needs a look";
const ISSUE_LABEL = "needs-a-look";
/** Slack's useful limit is well under its hard one; past this, the run link is the message. */
const SLACK_MAX_LINES = 40;

export interface NotifyContext {
  date: string;
  outcomes: SourceOutcome[];
  /** The run's URL, for both channels. */
  runUrl: string;
  /** The commit the run pushed, when it pushed one. */
  commitUrl?: string;
}

function changeLine(source: string, change: Change): string {
  const value = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));
  if (change.field === "added") {
    return `• ${source}: added ${change.target} (${value(change.to)})`;
  }
  return `• ${source}: ${change.target} ${change.field}: ${value(change.from)} → ${value(change.to)}`;
}

/** The Slack text for a run, or null when the run has nothing to announce. */
export function slackMessage(context: NotifyContext): string | null {
  const lines: string[] = [];
  const failures = context.outcomes.filter((o) => o.kind === "failed");
  const changes = context.outcomes.flatMap((o) =>
    o.kind === "applied" ? o.result.changes.map((c) => changeLine(o.result.source, c)) : [],
  );
  if (failures.length === 0 && changes.length === 0) {
    return null;
  }
  lines.push(`*Model registry — ${context.date}*`);
  if (failures.length > 0) {
    lines.push(`:red_circle: ${failures.map((f) => (f.kind === "failed" ? `${f.source} could not be read` : "")).join(", ")}`);
  }
  if (changes.length > 0) {
    lines.push(`${changes.length} change${changes.length === 1 ? "" : "s"}${context.commitUrl ? ` — <${context.commitUrl}|committed>` : ""}`);
    lines.push(...changes.slice(0, SLACK_MAX_LINES));
    if (changes.length > SLACK_MAX_LINES) {
      lines.push(`… ${changes.length - SLACK_MAX_LINES} more in the run`);
    }
  }
  lines.push(`<${context.runUrl}|run>`);
  return lines.join("\n");
}

export async function postSlack(webhookUrl: string, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const response = await fetchFn(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook → ${response.status} ${response.statusText}`);
  }
}

/** The issue body for a run, or null when nothing needs a look. */
export function issueBody(context: NotifyContext): string | null {
  const sections: string[] = [];
  for (const outcome of context.outcomes) {
    if (outcome.kind === "failed") {
      sections.push(`### ${outcome.source} — could not be read\n\n\`\`\`\n${outcome.error}\n\`\`\``);
    } else if (outcome.kind === "applied" && outcome.result.notes.length > 0) {
      sections.push(`### ${outcome.result.source}\n\n${outcome.result.notes.map((n) => `- ${n}`).join("\n")}`);
    }
  }
  if (sections.length === 0) {
    return null;
  }
  return [
    `What the daily update noticed on ${context.date} and would not change on its own. This issue is rewritten by every run and closed when the list is empty — act on an item and it disappears the next day.`,
    ...sections,
    `[run](${context.runUrl})`,
  ].join("\n\n");
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
}

/**
 * Create, rewrite or close the rolling issue. `repo` is `owner/name`. Answers
 * what it did, for the log.
 */
export async function syncIssue(
  token: string,
  repo: string,
  context: NotifyContext,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchFn(`${api}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status} ${response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  };

  const open = ((await call("GET", `/issues?state=open&labels=${ISSUE_LABEL}&per_page=20`)) as GitHubIssue[]).find(
    (issue) => issue.title === ISSUE_TITLE,
  );
  const body = issueBody(context);

  if (body === null) {
    if (open === undefined) {
      return "nothing needs a look; no issue open";
    }
    await call("POST", `/issues/${open.number}/comments`, { body: `Nothing needs a look as of ${context.date} — closing. ([run](${context.runUrl}))` });
    await call("PATCH", `/issues/${open.number}`, { state: "closed" });
    return `closed #${open.number}`;
  }
  if (open === undefined) {
    // The label may not exist yet; creating it twice answers 422, which is fine.
    try {
      await call("POST", "/labels", { name: ISSUE_LABEL, color: "fbca04", description: "The daily model update found something a person should decide" });
    } catch {
      /* already there */
    }
    const created = (await call("POST", "/issues", { title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] })) as GitHubIssue;
    return `opened #${created.number}`;
  }
  if (open.body === body) {
    return `#${open.number} unchanged`;
  }
  await call("PATCH", `/issues/${open.number}`, { body });
  return `updated #${open.number}`;
}
