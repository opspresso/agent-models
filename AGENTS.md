# AGENTS.md

Agent Models owns central provider connections, explicit model selection, inference routing and
model usage. Studio owns platform identities and permissions. Forge, Librio and Memory own their
jobs and use the selected models through this service. Shared conventions are in
`../agent-platform/docs/CONVENTIONS.md`; the cross-service refactor contract is in
`../agent-platform/docs/MODEL_ROUTER.md`.

## Architecture

Dependency direction: **app → lib → application → domain ← infrastructure**.

- `src/domain/` owns types, rules and repository/transport ports. It performs no network, database or filesystem I/O.
- `src/application/` owns management, admission and settlement. Inject adapters; do not import infrastructure or a composition root.
- `src/infrastructure/` owns PostgreSQL, provider protocols, discovery, encryption and the versioned catalog's filesystem adapter.
- `src/lib/` is the composition and authentication boundary. `src/app/` owns presentation and HTTP boundaries.
- Scripts compose these layers for catalog maintenance and verification.

Keep provider secrets on the server. Never log credentials, request bodies, generated content or raw
provider exceptions. Preserve the distinction between unknown cost and an explicit zero price.
Discovery does not enable models. Every dispatch validates current selection and records intent
before contacting a provider. Do not replay paid work after an uncertain outcome.

One installation shares PostgreSQL with the other Agent services. Models owns only `agent_models_`
tables and indexes. Never query or reset sibling tables. Preserve existing identities, settings,
data and encryption keys during the transition.

## Validation

Use Node 24 and the package manager version pinned in `package.json`.

```bash
pnpm typecheck
pnpm test
pnpm build:check
DATABASE_URL=<local disposable database ending in _test> pnpm test:integration
```

Integration creates and drops only its own isolated schema inside the local test database.
Tests for provider requests use fixtures, not paid public inference. Verify streaming boundaries,
abort, malformed usage, duplicate admission/settlement, current permissions and secret handling.
Performance claims require the same workload and a measured direct-call baseline.

Follow the Studio visual system for equivalent screens, including Korean/English, keyboard and
mobile behavior. Update code, configuration and docs together. Review all changed files before each
logical commit. Docs describe current behavior; incomplete requirements remain explicitly unbuilt.
