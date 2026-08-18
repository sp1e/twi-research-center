# TWI Research Center

A private, single-owner AI music studio. Musicians and producers: precise prompting,
arrangement, stems, MIDI, a timeline, and DAW-friendly export.

## What this repository is

A **history-preserving mirror** of the TWI paths extracted from the `sp1e.se` repository,
where TWI is developed. Every commit here is a real commit, with its original message and
date, filtered to the TWI files.

## What this repository is not

**It is not the source of truth, and it does not build or deploy on its own.**

TWI ships as a nested Cloudflare Pages Function inside the `sp1e.se` site. It shares that
project's `wrangler.toml`, `package.json`, D1 and R2 bindings, test runner and legacy
contract suite — none of which are TWI files, so none of them are here. Consequences:

- There is no `package.json`, so `npm install` and `npm test` do not work here.
- The eight-suite runner, the per-suite count floors and the manifest baseline gate all
  live in `sp1e.se`.
- Work happens in `sp1e.se` on `codex/twi-research-center-design`. This mirror is
  refreshed from it; edits made here would be overwritten.

## What to read first

| File | Why |
|---|---|
| `docs/superpowers/HANDOVER.md` | Current state, the working agreement, standing traps, open risks. Start here. |
| `docs/superpowers/specs/2026-08-16-twi-research-center-design.md` | The approved design and the locked product decisions. |
| `docs/superpowers/plans/2026-08-16-twi-creation-core.md` | The Release 1 implementation plan, 15 tasks. |
| `docs/superpowers/mutants/` | The mutation manifest — every mutant, its target, and which test kills it. |

## State

Release 1 — Creation Core. Tasks 1–7 of 15 complete: the isolated React studio shell, the
typed domain contracts and prompt compiler, the D1 schema, the repository and job state
machine, the authenticated Projects and Bootstrap API, image-reference ingestion, and the
estimate / idempotent submit / poll / cancel / retry path.

Nothing generates audio yet. The provider adapter is Task 9.

## Not mirrored

The development audit trail — review gates, fix-round reports and the controller ledger —
lives under a gitignored directory in `sp1e.se` and is therefore absent here. The tracked
documents above are the durable record.
