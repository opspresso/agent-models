/**
 * Retirement, by grace period.
 *
 * A provider's catalog no longer listing a model is the only signal there is
 * that it was retired — and for one day it is the same signal an outage gives.
 * So an absence is recorded first. Successful reads, at most once per UTC
 * date, advance its observation count. The day the model is back the state is
 * cleared. After `RETIREMENT_GRACE_OBSERVATIONS` absent observations the route is
 * hidden — never deleted, since a stored configuration may still name it and
 * past usage is priced by looking it up — and the note says when and why.
 *
 * A source that could not be read does not count either way.
 */

import type { PlacedOffering } from "../registry.ts";
import type { Change } from "./types.ts";

export const RETIREMENT_GRACE_OBSERVATIONS = 7;
export const RANKING_GRACE_OBSERVATIONS = 14;

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

/**
 * Record whether a live offering was found in its provider's catalog today.
 * Mutates the offering (callers work on a clone) and appends to `changes` and
 * `notes`; only catalog-hidden offerings are observed, so they can recover.
 */
export function observePresence(
  offering: PlacedOffering,
  present: boolean,
  sourceLabel: string,
  today: string,
  changes: Change[],
  notes: string[],
): void {
  if (offering.hidden && offering.hiddenReason !== "catalog") {
    return;
  }
  const id = `${offering.provider}/${offering.family}`;
  const target = `offering ${id}`;

  if (present) {
    if (offering.hiddenReason === "catalog") {
      changes.push({ target, field: "hidden", from: true, to: undefined });
      delete offering.hidden;
      delete offering.hiddenReason;
    }
    if (offering.missingSince !== undefined) {
      changes.push({ target, field: "missingSince", from: offering.missingSince, to: undefined });
      delete offering.missingSince;
    }
    delete offering.missingObservations;
    delete offering.lastMissingAt;
    return;
  }

  if (offering.missingSince === undefined) {
    changes.push({ target, field: "missingSince", from: undefined, to: today });
    offering.missingSince = today;
    offering.missingObservations = 1;
    offering.lastMissingAt = today;
  } else if (offering.lastMissingAt !== today) {
    offering.missingObservations = (offering.missingObservations ?? 1) + 1;
    offering.lastMissingAt = today;
  }

  const observations = offering.missingObservations ?? 1;
  if (observations < RETIREMENT_GRACE_OBSERVATIONS) {
    notes.push(
      `${id}: not in ${sourceLabel}'s catalog since ${offering.missingSince} (${observations} of ${RETIREMENT_GRACE_OBSERVATIONS} successful observations)`,
    );
    return;
  }

  const sentence = `Hidden automatically on ${today}: absent from ${sourceLabel}'s catalog since ${offering.missingSince}.`;
  changes.push({ target, field: "hidden", from: undefined, to: true });
  changes.push({ target, field: "missingSince", from: offering.missingSince, to: undefined });
  offering.hidden = true;
  offering.hiddenReason = "catalog";
  delete offering.missingSince;
  delete offering.missingObservations;
  delete offering.lastMissingAt;
  offering.note = offering.note === undefined ? sentence : `${offering.note} ${sentence}`;
  notes.push(`${id}: hidden — ${sentence}`);
}

/** Track whether an OpenRouter route still satisfies its automatic ranking policy. */
export function observeRankingEligibility(
  offering: PlacedOffering,
  eligible: boolean,
  today: string,
  changes: Change[],
  notes: string[],
): void {
  if (offering.hidden && offering.hiddenReason === undefined) return;
  const id = `${offering.provider}/${offering.family}`;
  const target = `offering ${id}`;
  if (eligible) {
    if (offering.hiddenReason === "ranking" || offering.hiddenReason === "reset") {
      if (offering.hiddenReason === "ranking") {
        changes.push({ target, field: "hidden", from: true, to: undefined });
      }
      delete offering.hidden;
      delete offering.hiddenReason;
    }
    delete offering.rankMissingSince;
    delete offering.rankMissingObservations;
    delete offering.lastRankMissingAt;
    return;
  }
  if (offering.hiddenReason === "reset") {
    changes.push({ target, field: "hidden", from: undefined, to: true });
    notes.push(`${id}: preserved as a hidden tombstone because it is outside the current OpenRouter ranking policy`);
    return;
  }
  if (offering.hidden && offering.hiddenReason !== "ranking") return;
  if (offering.rankMissingSince === undefined) {
    offering.rankMissingSince = today;
    offering.rankMissingObservations = 1;
    offering.lastRankMissingAt = today;
  } else if (offering.lastRankMissingAt !== today) {
    offering.rankMissingObservations = (offering.rankMissingObservations ?? 1) + 1;
    offering.lastRankMissingAt = today;
  }
  const observations = offering.rankMissingObservations ?? 1;
  if (observations < RANKING_GRACE_OBSERVATIONS) {
    notes.push(`${id}: outside the OpenRouter ranking policy (${observations} of ${RANKING_GRACE_OBSERVATIONS} successful observations)`);
    return;
  }
  if (!offering.hidden) changes.push({ target, field: "hidden", from: undefined, to: true });
  offering.hidden = true;
  offering.hiddenReason = "ranking";
  delete offering.rankMissingSince;
  delete offering.rankMissingObservations;
  delete offering.lastRankMissingAt;
  notes.push(`${id}: hidden after ${RANKING_GRACE_OBSERVATIONS} successful observations outside the OpenRouter ranking policy`);
}
