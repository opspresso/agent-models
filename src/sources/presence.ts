/**
 * Retirement, by grace period.
 *
 * A provider's catalog no longer listing a model is the only signal there is
 * that it was retired — and for one day it is the same signal an outage gives.
 * So an absence is *recorded* first: the offering gets `missingSince`, the
 * date it was first not found. It is cleared the day the model is back. When
 * it has been absent for `RETIREMENT_GRACE_DAYS` consecutive days the route is
 * hidden — never deleted, since a stored configuration may still name it and
 * past usage is priced by looking it up — and the note says when and why.
 *
 * A source that could not be read does not count either way: the day is
 * simply not observed, and `missingSince` neither starts nor advances.
 */

import type { PlacedOffering } from "../registry.ts";
import type { Change } from "./types.ts";

export const RETIREMENT_GRACE_DAYS = 7;

/**
 * The spellings under which a provider's own catalog may list an offering:
 * its wire name first, then its family. Either one is the model being alive —
 * a wireId exists to *rename dispatch*, not to narrow what counts as present,
 * and a provider's two API surfaces (native catalog vs OpenAI-compatible) do
 * not always list the same spelling. `google/gemini-3.1-pro` is the case in
 * hand: dispatch needs `gemini-3.1-pro-preview` while which spelling a
 * catalog lists has been observed to vary by the key reading it. Crediting
 * only one spelling starts the retirement clock on a model that answers.
 *
 * Provider-direct sources only — a router (OpenRouter) serves nothing but its
 * vendor-qualified wire ids, so its lookups stay on `wireId` alone.
 */
export function offeringNames(offering: PlacedOffering): string[] {
  return offering.wireId !== undefined && offering.wireId !== offering.family
    ? [offering.wireId, offering.family]
    : [offering.family];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from one `YYYY-MM-DD` to another, in UTC. */
export function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `YYYY-MM-DD` of a moment, in UTC — the job's clock. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return utcDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

/**
 * Record whether a live offering was found in its provider's catalog today.
 * Mutates the offering (callers work on a clone) and appends to `changes` and
 * `notes`; a hidden offering is not observed at all.
 */
export function observePresence(
  offering: PlacedOffering,
  present: boolean,
  sourceLabel: string,
  today: string,
  changes: Change[],
  notes: string[],
): void {
  if (offering.hidden) {
    return;
  }
  const id = `${offering.provider}/${offering.family}`;
  const target = `offering ${id}`;

  if (present) {
    if (offering.missingSince !== undefined) {
      changes.push({ target, field: "missingSince", from: offering.missingSince, to: undefined });
      delete offering.missingSince;
    }
    return;
  }

  if (offering.missingSince === undefined) {
    changes.push({ target, field: "missingSince", from: undefined, to: today });
    offering.missingSince = today;
    notes.push(
      `${id}: not in ${sourceLabel}'s catalog — hidden automatically on ${addDays(today, RETIREMENT_GRACE_DAYS)} if still absent`,
    );
    return;
  }

  const absentFor = daysBetween(offering.missingSince, today);
  if (absentFor < RETIREMENT_GRACE_DAYS) {
    notes.push(
      `${id}: not in ${sourceLabel}'s catalog since ${offering.missingSince} (day ${absentFor + 1} of ${RETIREMENT_GRACE_DAYS})`,
    );
    return;
  }

  const sentence = `Hidden automatically on ${today}: absent from ${sourceLabel}'s catalog since ${offering.missingSince}.`;
  changes.push({ target, field: "hidden", from: undefined, to: true });
  changes.push({ target, field: "missingSince", from: offering.missingSince, to: undefined });
  offering.hidden = true;
  delete offering.missingSince;
  offering.note = offering.note === undefined ? sentence : `${offering.note} ${sentence}`;
  notes.push(`${id}: hidden — ${sentence}`);
}
