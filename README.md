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
groups routes under their model. It wears Agent Studio's look (same tokens, faces and brand
marks under `docs/icons/brands/`, MIT-licensed Lobe Icons) with the studio's mark re-hued
warm for the favicon, so the two are recognisably siblings and never mistaken for each other.

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
  makers.json                 maker id → display label
  families/<maker>.json       { "<family>": { displayName, pricing, capabilities, contextWindow, maxTokens, note? } }
  offerings/<provider>.json   [ { family, wireId?, pricing?, capabilities?, maxTokens?, hidden?, missingSince?, note? } ]
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

1. Add the family to `models/families/<maker>.json` (a new maker goes in `makers.json`
   first) and an offering to each `models/offerings/<provider>.json` that serves it.
2. `pnpm format` — rewrites the files in canonical key order and validates them.
3. `pnpm build` — regenerates `docs/models.json`. CI fails if the committed catalog does not
   match its sources, so commit both.

Numbers come from the provider, not from memory: OpenRouter's `/api/v1/models` (public),
xAI's `/v1/language-models` (prices in 1e-10 USD per token — `12500` is $1.25/M), Anthropic's
`/v1/models` (`max_input_tokens`, `max_tokens`), the AWS Pricing API for Bedrock (mind the
unit — `1K tokens` and `1M tokens` rows are mixed), and the pricing pages for OpenAI and
Google, which publish no API for it.

## Keeping it current

`.github/workflows/update.yml` runs every day at 00:00 UTC (and on demand) and commits
whatever moved, which republishes the Pages site (`main:/docs`, served at
`models.opspresso.com`). It reads four sources, each independently:

| Source | Needs | May change |
|---|---|---|
| OpenRouter `/api/v1/models`, `/images/models`, `/models/{id}/endpoints` | nothing | a **router-only** family's price, discount, window and output cap; an OpenRouter offering's price override, discount included (set while the router's rate differs from the family's, dropped when they agree) |
| xAI `/v1/language-models`, `/v1/image-generation-models` | `XAI_API_KEY` | the text families' token prices (matched by id or alias; image models stay hand-kept) |
| Anthropic `/v1/models` | `ANTHROPIC_API_KEY` | the families' `contextWindow` and `maxTokens` (no price is published) |
| OpenAI `/v1/models` | `OPENAI_API_KEY` | no number — presence only |

A key that is not set skips its source and says so in the job summary. Every run writes
the summary: a table of what changed, and a *needs a look* list for what it noticed but
would not touch — a window a router disagrees on, an endpoint it could not read. The job
goes red when a source could not be read, but still commits what the others found.

### Retirement

Every source also watches **presence**: whether each live route is still in its provider's
catalog. A route that is not gets `missingSince` (the first day it was not found); the day
it is back, the field goes. After **7 consecutive days** absent the route is set
`hidden: true`, `missingSince` is dropped and a sentence is appended to its `note` saying
when and why. The summary announces the first absence (with the date it would be hidden
on), counts the days, and reports the hiding. What it never does is delete: a stored
configuration may still name the id, and past usage is priced by looking it up.

A day a source could not be read is not observed at all — the clock neither starts nor
advances — and an empty catalog is treated as a failed read, not as everything retired.
Google and Bedrock have no presence source here, so their routes are retired by hand: set
`hidden: true` and say why in `note`.

Run it locally with `pnpm update-models` (`--dry-run` to only report); the keys are read
from the same environment variable names.

Not automated, by choice: Google and OpenAI publish no pricing API; Bedrock's Pricing API
needs AWS credentials and a unit check per row; image pricing lives in per-image endpoints
whose numbers were verified against what a call was actually billed.

## Commands

```bash
pnpm install
pnpm format          # canonical key order + validation of models/
pnpm build           # models/ → docs/models.json
pnpm build:check     # exit 1 if docs/models.json is stale (CI)
pnpm update-models   # pull the live sources into models/ (--dry-run to report only)
pnpm typecheck
pnpm test
```

Node 24+, pnpm 11. The scripts are TypeScript run by Node directly; the only dependency is
`typescript` for the type check.
