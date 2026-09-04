# TWI Research Center

A private, single-owner AI music studio. Musicians and producers: precise prompting,
arrangement, stems, MIDI, a timeline, and DAW-friendly export.

## What this repository is

A self-contained TWI checkout that can install dependencies, build the browser app, run
the TWI verification suites, and deploy the Pages application and Function from this
repository.

The application history is still synchronized from the TWI paths in `sp1e.se`, where the
feature was originally developed. The root integration files in this repository make that
extracted history usable on its own.

## Local development

Requirements: Node.js 20 or newer, npm, Python 3 for the finishing-helper suite, and a
separate install for the orchestrator Worker.

```sh
npm ci
npm ci --prefix twi-orchestrator
npm test
npm run typecheck
npm run build
```

Run the Pages application locally with `npm run dev`. The browser app is served under
`/twi/`, and the API is handled by `functions/api/twi/[[route]].ts`.

## Cloudflare deployment

`wrangler.toml` declares the Pages project plus its D1 `DB`, R2 `FILES`, and
`TWI_ORCHESTRATOR` service bindings. The checked-in migrations remain the schema source
for the TWI tables. Configure Cloudflare credentials and set `AUTH_PASSWORD_HASH` as a
Pages secret before using `npm run deploy`; tokens, password hashes, and provider secrets
must stay in Cloudflare or `.dev.vars`, never in Git.

## What to read first

| File | Why |
|---|---|
| `docs/superpowers/HANDOVER.md` | Current state, the working agreement, standing traps, open risks. Start here. |
| `docs/superpowers/specs/2026-08-16-twi-research-center-design.md` | The approved design and the locked product decisions. |
| `docs/superpowers/plans/2026-08-16-twi-creation-core.md` | The Release 1 implementation plan, 15 tasks. |
| `docs/superpowers/mutants/` | The mutation manifest — every mutant, its target, and which test kills it. |

## State

Release 1 — Creation Core. Tasks 1–11 of 15 are present: the React studio shell, typed
domain and persistence layers, authenticated API, image ingestion, job lifecycle, Workflow
orchestrator, Lyria provider adapter, Modal finishing, publication validation, and
provider-call reconciliation safeguards. Task 12—the typed API client and project
library—is the next planned product increment.

## Repository boundaries

The development audit trail—review gates, fix-round reports, and the controller ledger—
is intentionally not copied from `sp1e.se`. The tracked design, plan, handover, mutation
manifest, application code, deployment configuration, and runnable verification suites
are the durable standalone record here.
