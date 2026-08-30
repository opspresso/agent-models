# agent-models

A curated LLM model registry — per-model pricing, context window, output cap and
capability flags — published as one static JSON:

```
https://models.opspresso.com/models.json
```

(`https://opspresso.github.io/agent-models/models.json` redirects there.)

[Agent Studio](https://github.com/opspresso/agent-studio) is the consumer it is shaped
for: every field mirrors its `src/domain/llm/models.ts`, and the catalog is the list that
registry will load instead of carrying the numbers in code. Anything that can read JSON
can use it the same way. A browsable view of the same file is at
<https://models.opspresso.com/> — `docs/index.html`, a static page that reads the catalog and
mirrors the console's own Models page (<https://studio.opspresso.com/models>): the same
catalog header, filter row (search, provider, capabilities, sort) and one card per route,
drawn with the same tokens, faces and brand marks (`docs/icons/brands/`, MIT-licensed Lobe
Icons). The studio's mark is re-hued green for this site's logo and favicon, so the two
are recognisably siblings and never mistaken for each other.

## The catalog

```jsonc
{
  "version": 1,
  "updatedAt": "2026-08-20T00:03:11.000Z",   // when the content last changed — not when it was last checked
  "source": "https://github.com/opspresso/agent-models",
  "providers": ["openai", "anthropic", "google", "xai", "bedrock", "openrouter"],
  "makers": { "openai": "OpenAI", "anthropic": "Anthropic", "zhipu": "Z.ai", ... },
  "models": [
    {
      "id": "openrouter/claude-opus-4.8",        // provider/family — the id a run names
      "provider": "openrouter",                  // the route
      "family": "claude-opus-4.8",               // the model
      "maker": "anthropic",                      // who made it, whatever the route
      "displayName": "Opus 4.8",
      "pricing": { "inputPer1M": 5, "outputPer1M": 25, "cachedInputPer1M": 0.5 },
      "capabilities": { "tools": true, "structuredOutput": false, "imageInput": true, "reasoning": true },
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "wireId": "anthropic/claude-opus-4.8",     // only when the provider names it differently
      "hidden": true                             // only when retired: resolvable, not offered
    }
  ]
}
```

Prices are USD per million tokens; image models add `imageInputPer1M`, `imageOutputPer1M`,
`perImage` and `perInputImage`, and are priced by token rate *or* per image. Every rate is
the provider's base, standard-tier rate — a long-context or priority tier is not expressed.
`pricing.discount`, when present, is a promotional discount (a fraction) that the stated
rates are **already net of** — OpenRouter publishes one per endpoint, and the catalog's
price is the default endpoint's — so a reader can tell a promotion from a price and put the
list rate back with `inputPer1M / (1 - discount)`. Absent means no discount is known.
`reasoningWithTools: false` marks a model whose provider rejects `tools` together with
`reasoning_effort` on chat/completions.

`hidden` is for routes that have been retired: a stored configuration may still name one,
and past usage is priced by looking it up, so it stays in the list and out of the picker.
**An entry is deleted only when nothing can ever have referred to it.**

## How the registry is written

What a model *is* and who *serves* it are two lists, resolved into the catalog at build time.

```
models/
  providers.json              the routes a model id may be prefixed with, in catalog order
  makers.json                 maker id → { displayName, openrouterVendor? }
  families/<maker>.json       { "<family>": { displayName, pricing, capabilities, contextWindow, maxTokens, note? } }
  offerings/<provider>.json   route overrides plus hidden/presence/ranking lifecycle bookkeeping
  removals.json               exact published ids proposed for permanent removal through a PR
```

A **family** states the model once — price, window, what it can do. An **offering** says a
provider serves it, under which wire name, and what the route changes: a router's own rate,
a gateway that cannot do structured output, a retirement. Overrides are shallow merges over
the family, so an offering names only what differs. The file an entry sits in is its maker
or provider; neither is repeated inside the entry.

Three things follow from the split and are enforced by `validateRegistry` (and CI):

- the same model reached two ways has one name, one maker, one window and one kind — an
  offering may not change `contextWindow` or `imageGeneration`;
- a `wireId` exists only to say something the id does not: a router route must carry a
  vendor-qualified one (`anthropic/claude-opus-4.8`), and a dotted Anthropic id must carry
  the hyphenated name Anthropic actually serves (`claude-opus-4-8`);
- a text model is priced on both sides, an image model by token rate or per image, a cached
  rate never exceeds the uncached one, and the output cap fits in the window.

A `note` holds provenance a reader of the file needs — where an odd number came from, why a
retired route is priced the way it is. It is for people; the catalog does not carry it.

### Routes

- **Bedrock** offerings go through the OpenAI-compatible `bedrock-mantle` endpoint; wire ids
  are the endpoint's own (`openai.gpt-oss-120b`). `structuredOutput` is off for the route,
  not the model: mantle rejects the parameter whatever is behind it. Claude is absent on
  purpose — Bedrock serves it on the Anthropic Messages API only.
- **OpenRouter** ids are `vendor/model`, so every offering carries a wire id. A route
  restates a price only while OpenRouter's catalog differs from the family's rate.
- **Anthropic** hyphenates what this registry dots, hence the wire ids on `claude-*-4.x`.

## Adding or changing a model

1. Add the family to `models/families/<maker>.json` (a new maker, including its optional
   OpenRouter vendor slug, goes in `makers.json` first) and an offering to each
   `models/offerings/<provider>.json` that serves it.
2. `pnpm format` — rewrites the files in canonical key order and validates them.
3. `pnpm build` — regenerates `docs/models.json`. CI fails if the committed catalog does not
   match its sources, so commit both.

Published ids first become `hidden` tombstones. After an automatically hidden route remains
hidden for **30 days**, the workflow creates or updates one draft deletion PR. That PR
accumulates an exact `{ id, reason, requestedAt }` entry in `models/removals.json` for each
route, requests its code owner and is not auto-merged. CI rejects a removal that no entry
requests — on pull requests, which is where it is checked. `main` carries no ruleset, so a
push straight to it is not checked at all.

Numbers come from the provider, not from memory: OpenRouter's `/api/v1/models` (public),
xAI's `/v1/language-models` (prices in 1e-10 USD per token — `12500` is $1.25/M), Anthropic's
`/v1/models` (`max_input_tokens`, `max_tokens`), the AWS Pricing API for Bedrock (mind the
unit — `1K tokens` and `1M tokens` rows are mixed), and the pricing pages for OpenAI and
Google, which publish no API for it.

## Keeping it current

`.github/workflows/update.yml` runs every day at 22:00 UTC (and on demand), validates whatever
moved and merges routine updates through a pull request — which republishes the Pages site (`main:/docs`, served at
`models.opspresso.com`) — and tells people about it. Three phases, every source
independent of the others:

1. **fetch** — each source reads its catalog; one failing is reported and the rest go on;
2. **discover** — what the catalogs list that the registry does not: new families and new
   routes (below);
3. **apply** — numbers, discounts, presence and retirement for every route the registry
   now has, the ones just added included.

| Source | Needs | May change | May add |
|---|---|---|---|
| OpenRouter `/api/v1/models`, `/images/models`, `/models/{id}/endpoints`, public weekly text and image rankings feeds | nothing | a **router-only** family's price, discount, window and output cap; an OpenRouter offering's price override, discount included (set while the router's rate differs from the family's, dropped when they agree) | eligible text and image families; OpenRouter routes to existing families |
| xAI `/v1/language-models`, `/v1/image-generation-models` | `XAI_API_KEY` | the text families' token prices (matched by id or alias; image models stay hand-kept) | `xai/` routes |
| Anthropic `/v1/models` | `ANTHROPIC_API_KEY` | the families' `contextWindow` and `maxTokens` (no price is published) | `anthropic/` routes |
| OpenAI `/v1/models` | `OPENAI_API_KEY` | no number — presence only | `openai/` routes |
| Google `/v1beta/models` | `GOOGLE_API_KEY` | the families' `contextWindow` and `maxTokens` (no price is published) | `google/` routes |

A key that is not set skips its source and says so. Bedrock has no source here: its routes
are added and retired by hand, with numbers from the AWS Pricing API.

### Additions

**A new family** is created from OpenRouter's catalog when a listing is filed under a maker's
`openrouterVendor` in `makers.json`; is a priced text model (not `:free`/`:batch`/`:nitro`
variants or a `-20250929`/`-0813` dated snapshot); and states a context window plus a usable
max output in the aggregate model or at least one endpoint. It must also be either from
OpenAI, Anthropic, Google or xAI and first
listed within the last **30 days**, or present in the weekly usage leaderboard's first
**20 open-weight** or first **20 closed-weight** rows. Ranked models are eligible regardless
of listing age. The ranking is the same one shown at
`openrouter.ai/rankings`: prompt and completion tokens are totalled by variant, models with
a Hugging Face id are open weight, and the rest are closed weight. A ranked serving variant
qualifies its standard model family.

The text family gets OpenRouter's numbers and flags (`tools`, `structured_outputs`, image
input, `reasoning`), a `note` saying when and where it came from, and an OpenRouter route.
The aggregate max output is preferred; when it is absent, the largest valid endpoint cap is
used because OpenRouter routes a `max_tokens` request only to endpoints that support it.
An eligible text model from a maker this registry does not know and an eligible listing
without any output cap go to the *needs a look* list instead. Unranked non-major text models
are ignored. If the public text rankings feed fails or changes shape, the run still updates
existing routes and major-maker additions but adds no text family from another maker. Older
unranked listings are the backlog, which is a person's — the window keeps a first run from
importing a major vendor's whole history.

**An image family** is created when it appears in the weekly image leaderboard's first
**20 rows**, ordered by image-producing request count as on `openrouter.ai/rankings/image`.
The image catalog supplies its name and modalities; `/models/{id}/endpoints` supplies the
normalized image-token price, context window and output cap. Explicit zero limits are retained
for image-only models when OpenRouter publishes them. A previously unknown maker is added from
the ranked model's vendor slug and display-name prefix. Image ranking failure or missing
endpoint price/limits fails closed for image additions without blocking text updates.

**A new route** is added when a catalog serves a family the registry already has: OpenRouter
under `<vendor>/<family>`, a vendor under the family id (Anthropic's hyphenated spelling
becomes the `wireId`). OpenRouter applies the same major-maker or leaderboard eligibility
gate to routes and families. Two further guards: a family every route of which is hidden is
never routed again — it was retired on purpose — and an OpenRouter listing is routed only
when its context window equals the family's, the one cheap identity check there is
(`qwen/qwen3-235b-a22b` is the original model; this registry's `qwen3-235b-a22b` is the
Instruct 2507). A text route narrows `tools`/`structuredOutput` when the router lacks them.
An image route is added only while its model is in the weekly image Top 20. The first
*vendor* route to a router-only family puts the family at the list price (the router's
discount moves to the router's offering).

### Retirement

Every source also watches **presence**: whether each live route is still in its provider's
catalog. A route that is not gets `missingSince` and an observation count; retries on the
same UTC date count once. The day it is back, the bookkeeping goes. After **7 successful
absent catalog observations** the route is set
`hidden: true`, `missingSince` is dropped and a sentence is appended to its `note` saying
when and why. The lifecycle update itself never deletes; it preserves the tombstone until
the separate draft deletion PR is reviewed.

OpenRouter uses separate admission and retention thresholds so models around the cutoff do
not churn. Text enters through the weekly open- or closed-weight Top 20 and remains eligible
through the corresponding **Top 50**; image enters through the weekly Top 20 and remains
eligible through the **Top 30**. A listing is exempt from ranking retirement for its first
**90 days**. Major-maker text routes with a live vendor route are also exempt, while an
OpenRouter-only OpenAI, Anthropic, Google or xAI family follows the same retention policy as
other OpenRouter-only families.

After **30 successful ranking observations** outside the retention threshold, the route is
hidden with a structured `hiddenAt` date. Re-entry during the tombstone period restores it
automatically. A failed ranking read or a feed that cannot supply the complete Top 50/30
retention set does not advance this lifecycle. Routes hidden manually remain manual and are
never restored by automation. An automatically hidden route becomes a permanent-removal
candidate only after its 30-day tombstone period; candidates accumulate in the existing
draft removal PR until it is reviewed.

A source read that fails is not observed at all — neither lifecycle advances — and an empty,
partial or malformed catalog is treated as a failed read, not as everything retired.
Bedrock has no presence source, so its routes are retired by hand: set `hidden: true` and
say why in `note`. OpenRouter's announced `expiration_date` (within a year) is reported ahead
of time.

Before anything is written, a safety gate quarantines destructive bulk changes: removals,
provider-wide disappearance and mass catalog hiding. Ranking-qualified retirement, valid
provider metadata changes and additions are applied automatically. The report is still
produced for review, but `models/` remains unchanged when the gate trips. Network reads
refuse redirects, time out after 30 seconds and cap JSON responses at 10 MiB. After reviewing
the complete diff, a person may apply that exact anomaly set by
rerunning with the digest-specific `--approve-anomaly=<digest>` printed in the report — from
CI by dispatching **Update models** with the digest in the `approve_anomaly` input. The
approval is the digest alone, so a set that has since changed is quarantined again with a new
one rather than waved through.

### Notifications

Two channels with two jobs, both optional and run even when a later build or test fails
(`scripts/notify.ts`):

- **Slack** (`SLACK_WEBHOOK_URL`) carries *events*: a message per run that changed
  something — a price, a route added, a family added, a model retired — or that failed: a
  source that could not be read, a quarantined anomaly set, a patch that would leave the
  registry invalid. The run is linked. A quiet day posts nothing.
- **A rolling GitHub issue** (the workflow's own token) carries *state*: "Model registry:
  needs a look", rewritten by every run with everything that needs a person — an unknown
  maker, a window a router disagrees on, an absence being counted down, a source that could
  not be read — and closed the day the list is empty. Act on an item and it disappears the
  next day.

The job summary holds the full report on every run, including one that refused to write:
a table of what changed and the *needs a look* list.

Run the update locally with `pnpm update-models` (`--dry-run` to only report); the keys are
read from the same environment variable names. `--reset-openrouter` first preserves every
OpenRouter route as a hidden reset tombstone, then restores or adds the routes allowed by the
current major-maker and Top 20 policies. The reset is not written unless both rankings are
complete and every image Top 20 endpoint has usable standard-tier price and limits.

## Commands

```bash
pnpm install
pnpm format          # canonical key order + validation of models/
pnpm build           # models/ → docs/models.json
pnpm build:check     # exit 1 if docs/models.json is stale (CI)
pnpm check-removals -- HEAD^ --pull-request # verify PR removals against models/removals.json
pnpm propose-removals # turn update-report.json candidates into a draft-PR deletion patch
pnpm update-models   # pull the live sources into models/ (--dry-run to report only)
pnpm update-models --reset-openrouter # rebuild only OpenRouter from all eligible models
pnpm notify          # deliver update-report.json to Slack / the issue
pnpm typecheck
pnpm test
```

Node 24+, pnpm 11. The scripts are TypeScript run by Node directly; nothing is installed to
run them — `typescript` and `@types/node` are dev dependencies for the type check alone.
