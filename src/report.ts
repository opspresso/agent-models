/** The update's report, as Markdown — the job summary on GitHub, stdout locally. */

import type { SourceResult } from "./sources/types.ts";

export type SourceOutcome =
  | { kind: "applied"; result: SourceResult }
  | { kind: "skipped"; source: string; reason: string }
  | { kind: "failed"; source: string; error: string };

function inline(value: unknown): string {
  return String(value).replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").replaceAll("@", "&#64;");
}

function cell(value: unknown): string {
  if (value === undefined) {
    return "—";
  }
  return `\`${inline(JSON.stringify(value)).replaceAll("`", "\\`")}\``;
}

export function renderReport(outcomes: SourceOutcome[], date: string): string {
  const lines: string[] = [`## Model update — ${date}`, ""];
  for (const outcome of outcomes) {
    if (outcome.kind === "skipped") {
      lines.push(`### ${inline(outcome.source)} — skipped`, "", inline(outcome.reason), "");
      continue;
    }
    if (outcome.kind === "failed") {
      lines.push(`### ${inline(outcome.source)} — failed`, "", ...String(outcome.error).split(/\r?\n/).map((line) => `    ${inline(line)}`), "");
      continue;
    }
    const { source, changes, notes } = outcome.result;
    lines.push(`### ${inline(source)} — ${changes.length} change${changes.length === 1 ? "" : "s"}`, "");
    if (changes.length > 0) {
      lines.push("| Target | Field | From | To |", "|---|---|---|---|");
      for (const change of changes) {
        lines.push(`| ${inline(change.target)} | ${inline(change.field)} | ${cell(change.from)} | ${cell(change.to)} |`);
      }
      lines.push("");
    }
    if (notes.length > 0) {
      lines.push("Needs a look:", "");
      for (const note of notes) {
        lines.push(`- ${inline(note)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
