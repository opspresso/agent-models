# Model catalog consumer contract

`agent-models` publishes facts about model routes. It does not provide an inference
gateway, register service connections, choose a user's model or authorize requests.
The catalog version is `1`; consumers reject unsupported versions and retain a
validated local snapshot so offline startup does not depend on a network fetch.

## Identifiers and private configuration

| Value | Owner and meaning |
|---|---|
| Catalog `id` | Public route identity, `provider/family`; use for `catalogId` and historical model attribution |
| `wireId` | Optional provider request name. Use `wireId ?? family` when building a connection; do not send the public route ID blindly |
| Service connection `id` | Forge channel or Librio model ID exposed by that service's allowed-model endpoint |
| Endpoint, protocol, API key | Private service configuration; never catalog fields or caller-supplied task inputs |
| Connection revision | Service-owned policy snapshot. Preserve it with jobs and usage; catalog `updatedAt` is not an authorization revision |

A catalog entry is evidence about an explicitly selected connection. Discovery does
not enroll every model or expand a caller's allowlist. Caller ownership, runtime,
protocol, current permissions and budget remain service checks. A hidden entry
stays resolvable for historical usage but is not a default picker choice.

## Match the requested purpose

Model type is derived from mutually exclusive capability flags. A model without a
specialized type flag is text. Never infer type from its name or provider.

| Consumer purpose | Allowed catalog type | Additional service requirement |
|---|---|---|
| Studio conversation | Text, or an explicitly supported image workflow | Agent model policy and route protocol |
| Forge Codex | Text with `tools:true` | Responses protocol |
| Forge Claude | Text with `tools:true` | Messages protocol |
| Forge OpenCode | Text with `tools:true` | Responses or Chat Completions protocol |
| Librio summary or meeting minutes | Text | Configured summary adapter and output limit; tools are not required |
| Librio transcription | `transcription:true` | Transcription adapter, audio formats and provider limits |
| Librio embedding | `embedding:true` | Embedding endpoint, dimensions and index fingerprint |
| Librio reranking | `rerank:true` | A separately supported rerank adapter |

`decision`, `imageGeneration`, `embedding`, `rerank` and `transcription` models are
not text summary or native coding models. `imageInput` is independent and does not
mean image generation. Catalog capability does not prove a service implements that
wire API. A text model served on Messages cannot be sent through Responses merely
because its tools flag is true.

`catalogId` must resolve in the pinned version and match the configured purpose.
An explicitly declared self-hosted connection can omit `catalogId`; its operator
must supply its purpose/capabilities, protocol and bounds. Do not invent a catalog
ID for a private model or fetch arbitrary URLs provided by a task.

## Prices and usage

Version 1's curated published entries contain verified pricing. A missing catalog
entry, unknown provider usage or unpriced local connection remains **unknown**.
Never replace missing `pricing`, an absent rate, an unsupported billing unit or a
missing usage receipt with zero. Only an explicit applicable zero rate means free.
An embedding model's `outputPer1M:0` does not make its paid input free; transcription
with zero token rates can still charge `perAudioMinute`.

Rates are USD per million tokens unless the field names another unit. Choose the
applicable units (`perImage`, `perSearch`, `perAudioMinute`) before estimating cost.
`discount` is already reflected in published rates. Do not apply it twice.
Per-request admission limits and token caps do not replace combined cost budgets.

Persist the chosen public ID, connection revision, pricing snapshot and actual
usage with the request. If a response is uncertain, keep that outcome; replaying
inference is not a way to recover a missing accounting receipt. Retired catalog
entries preserve evidence but are not a guarantee that a provider still serves them.

## Snapshot updates and compatibility

Refresh only from the configured official catalog or a repository-owned local
snapshot. Validate version, identity, capability and prices before atomically
replacing a snapshot. Retain the previous valid snapshot when a refresh fails and
report its revision; do not silently assign empty facts or zero prices.

The [JSON schema](catalog-v1.schema.json) describes the published version 1 shape.
`validateRegistry` also checks source-to-offering consistency, wire IDs, pricing
units and model-specific limit relationships. Additive optional facts must not
change existing meanings; incompatible meanings or required fields need a new
catalog version. No service keys or endpoints belong in either version.
