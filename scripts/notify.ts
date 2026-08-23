/**
 * Deliver the run's findings after an update attempt. Reads
 * `update-report.json` (left by `update.ts`); does nothing when the
 * file is absent, because a run that wrote nothing has nothing to say.
 *
 * Channels are optional and independent:
 *   SLACK_WEBHOOK_URL           → a message per run that changed something or failed
 *   GITHUB_TOKEN + GITHUB_REPOSITORY → the rolling "needs a look" issue
 * Either failing makes the step fail; neither is silently skipped when set.
 */

import { existsSync, readFileSync } from "node:fs";
import { issueBody, postSlack, slackMessage, syncIssue, type NotifyContext } from "../src/notify.ts";
import type { SourceOutcome } from "../src/report.ts";
import { REPORT_PATH } from "./_root.ts";

if (!existsSync(REPORT_PATH)) {
  console.log("no update-report.json — nothing to notify");
  process.exit(0);
}
const report = JSON.parse(readFileSync(REPORT_PATH, "utf-8")) as { date: string; outcomes: SourceOutcome[] };
const context: NotifyContext = {
  date: report.date,
  outcomes: report.outcomes,
  runUrl: process.env.RUN_URL ?? "https://github.com/opspresso/agent-models/actions",
  ...(process.env.COMMIT_URL ? { commitUrl: process.env.COMMIT_URL } : {}),
};

let failed = false;

const webhook = process.env.SLACK_WEBHOOK_URL;
if (webhook) {
  const text = slackMessage(context);
  if (text === null) {
    console.log("slack: nothing to announce");
  } else {
    try {
      await postSlack(webhook, text);
      console.log("slack: posted");
    } catch (error) {
      failed = true;
      console.error(`slack: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} else {
  console.log("slack: SLACK_WEBHOOK_URL not set — skipped");
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (token && repo) {
  try {
    console.log(`issue: ${await syncIssue(token, repo, context)}`);
  } catch (error) {
    failed = true;
    console.error(`issue: ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  console.log(`issue: ${issueBody(context) === null ? "nothing needs a look" : "GITHUB_TOKEN/GITHUB_REPOSITORY not set — skipped"}`);
}

process.exit(failed ? 1 : 0);
