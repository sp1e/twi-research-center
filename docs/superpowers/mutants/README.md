# TWI mutant manifest

`twi-creation-core.mutants.json` is the tracked record of every mutant this workstream has run
against the TWI Creation Core. It exists because the set previously lived only as prose scattered
across agent reports in a gitignored directory, so each round had to **reconstruct** the previous
round's baseline by hand from write-ups rather than **verify** it.

Mutation testing is how this project decides whether a suite can detect wrong behaviour at all. It
has repeatedly found suites that were 100% green and provably useless — 9 of 12 mutants surviving
the prompt compiler, 9 of 23 surviving the D1 schema, one of them masking double-billing on the
money path. Those findings are the reason the manifest is worth maintaining.

## Reading it

| Field | Meaning |
|---|---|
| `id` | Stable, namespaced, never reused: `DOM-*` domain, `SCH-*` schema, `REPO-*` repository, `APP-*` app shell, `MIG-*` migration tooling, `API-*` the authenticated API surface. |
| `historicalLabels` | What each round called it (`M1`, `M06`, `spot-check A`, …). Kept because the reports are the evidence and they use these labels. |
| `target` | The file and the construct. |
| `mutation` | A literal `find` / `replace` pair, or `sites[]` for one logical change at several places, or a `mechanicalRule` for line deletions. |
| `expected` | What must happen: `killed`, `known-survivor`, `retired`. |
| `appliesAtCommit` | Present when the mutant targets code that does not exist at the baseline. Three do (`DOM-37R/38R/39R`, at `b69678b`). |
| `premise` | A version-dependent assumption the kill signal rests on. Three entries depend on zod 3.25.76 reading array elements in exactly one place. |
| `killedBy` | The tests that must fail. Treat as a **lower bound** — see below. |
| `provenance` | Which round introduced it, and its verdict there, so the evidence is findable. |
| `substantiation` | How solid the entry is: `exact-from-source`, `described-only`, `aggregate-only`. |

## Verifying a claim

```
# 1. suite green first — a mutant against a red tree measures nothing
npm run test:twi

# 2. apply ONE mutant: a literal substitution of mutation.find -> mutation.replace
#    (find is verified to occur exactly once in the target file at ac034a4)

# 3. run the set's testCommand and compare with `expected`

# 4. restore
git checkout -- <target file>
npm run test:twi
```

If a mutant marked `killed` leaves the suite green, the coverage it guards has been lost. That is a
finding, not a curiosity.

## Do not

- **Do not delete a retired mutant.** `DOM-14` is retired because the reserved-prefix rule it
  reverted was deliberately removed by ruling R6. It stays listed with its reason, its
  `retirement.kind` and its successor (`DOM-23`). Silently dropping a mutant makes a real coverage
  loss look like tidy housekeeping.
- **Do not conflate the two retirement kinds.** `behaviour-removed` means the code is gone.
  `became-equivalent` means the code is still there but the mutation can no longer change behaviour
  on any input, so it is unkillable by construction — it reads as a survivor and drags the score
  down for nothing, while deleting it hides that a real check stopped being reachable. `DOM-32R`
  carries the worked example: the round that moved the array pre-bound *removed* the old `.max()`
  instead of keeping it as a backstop, precisely so that mutant stayed killable. Had both copies
  been kept, the set would have quietly read 7/8 with nothing actually wrong.
- **Do not sum the headline scores.** Every one was measured on a different base commit, by a
  different round, with a different uncommitted harness, against a suite of a different size.
- **Do not assume one target file means one kill suite.** `SCH-HOUR24` mutates the migration but is
  killed by `test:twi`; `test:twi:schema` stays 39/39 green under it.
- **Do not apply `DOM-02` with `DOM-06`, or `DOM-08` with `DOM-20`.** They share anchors.

## What the record cannot tell you

Stated here because the manifest is only worth what its honesty is worth.

1. **The numbering collides, and that fact is part of the record.** Two independent mutants are
   published as `M29`: the fence line-break parity revert (`DOM-29P`) and the raw-bound scalar bound
   removal (`DOM-29R`). Two rounds branched from `33ddf34` and each took the next free number. A
   later round relabelled the raw-bound block `R29`–`R36` to cope, but **`raw-bound-report.md` was
   never edited**, so those eight mutants now carry two published labels each depending on which
   report you read. Both are recorded; neither claimant was renumbered away or merged.
2. **A combined baseline now exists, and an earlier draft of this manifest said it did not.** The
   correction is left visible in `uncertainty.combinedBaseline` rather than edited out. The
   `raw-prebound` round reproduced both domain sets on `ac034a4`'s domain source — verified here by
   blob hash `29c741c` and by its baseline of 262 tests matching this round's own measurement —
   giving **36/36 killed, 0 survivors**. That covers the domain files only: the schema, repository,
   app-shell and migration-tooling sets still have no measurement at `ac034a4`.
3. **56 of the schema mutants are not recoverable.** group-e's `79/79` is a real measurement of a
   set that survives only as eight group descriptions with counts — and those counts sum to 81
   against the base 23, not 79, so at least two members are double-counted somewhere.
4. **Four entries carry no applicable mutation** (`DOM-26`, `SCH-K05`, `REPO-04`, `REPO-06`). Their
   descriptions admit several different edits with different kill sets, so none is guessed.
   `DOM-26` is one of the three *mandated* fence mutants, which makes it the most worth repairing.
5. **`killedBy` is a lower bound.** Spot-checking `DOM-03` found five killing tests where the
   report implied two.
6. **Three entries rest on a dependency version.** `DOM-37R/38R/39R` are killed by an element-parse
   counter that is only valid while zod reads array elements in exactly one place — true at 3.25.76,
   cross-checked because the accepted control gives exactly *n* reads and never *2n*. A zod upgrade
   could invalidate the *measurement* silently rather than fail the code, so a green run after a bump
   is not evidence until the replica contract test is re-read.
7. **No harness was ever committed.** All four lived in session scratchpads.
8. **`progress.md` is stale** relative to the last six rounds, so the commit graph — not the
   ledger — is what establishes what is merged at `ac034a4`.

## Measured in this round

All 75 anchors verified unique — 72 against the tree at `ac034a4`, three against `b69678b`'s blob.
Five mutants applied for real and reverted, all killed as recorded:

| Mutant | Result |
|---|---|
| `DOM-03` novelty hardcoded | 5 failed / 257 passed (report implied 2 killing tests; 5 measured) |
| `SCH-M06` money-path replay key widened | 1 failed / 38 passed, "Missing expected exception" |
| `SCH-HOUR24` hour-24 conjuncts deleted | 18 failed / 244 passed, naming all 60 vectors |
| `DOM-29P` fence line-break parity reverted | 9 failed / 253 passed, the 6 schema cases green as predicted |
| `DOM-38R` array pre-bound ordering reverted | 6 failed / 198 passed, counts 33/129/65/65/100000, older files blind |

The `DOM-38R` check also reproduced its round's 285/14-file baseline, and confirmed that `ac034a4`'s
unmodified `raw-bounds.test.ts` passes against the `b69678b` schema — independent evidence that no
assertion was weakened there. `DOM-37R` and `DOM-39R` are anchor-verified but not applied.
Everything else is transcribed from the reports with provenance attached: the manifest is a
faithful, applicable index of those claims, not a re-measurement of them.

## Added in v1.1.0 — the `api` set (29 entries, Task 5's boundary)

Task 5 built the authenticated API and ran 21 mutants against it, and **none of them were in this
file**: the manifest did not exist at Task 5's base, so that round could not have registered them.
Two independent gates then found the same hole in its route-placement lock, and one of them found a
surviving mutant. The gate-hardening round added the set and, unlike the transcription that makes up
most of this manifest, **applied all 29 for real**:

- **29/29 killed**, measured at `fix/twi-task5-gate-hardening` (base `f24cc24`), after reproducing
  that tree's own baseline first (`npm test` 7/7, `test:twi` 349, contract check 26).
- **`killedBy` in this set is measured, not transcribed.** Every entry carries `measured: true`.
  Four lists came out broader than the introducing report implied — the same correction spot-checking
  `DOM-03` produced. They are measured *at that tree*, which includes four kill signals the
  introducing round did not have.
- **Seven entries are recorded as former survivors, deliberately.** `API-23` (published by gate 2),
  `API-24`, `API-25`, `API-26` survived Task 5's tests; `API-27` (in seven of its eight spellings),
  `API-28` and `API-29` survived Task 5's contract check. Reading any of them as "always killed"
  would misstate the coverage history of the auth boundary, so each says so in
  `provenance.originalVerdict`, and the placement ones carry `notKilledBy` and a `premise` naming
  the assertion their kill now depends on.
- **Two kill suites, and neither is sufficient.** Nine entries are text-only facts no runtime suite
  can see; `API-15` is invisible to the contract check; and `API-21` orphans the very suite that
  kills it, so `npm test` goes green under it. See the set's `testCommandWarning`.

Why a new namespace rather than more `REPO-*`: that set already targets `src/twi/server/`, so
extending it would have put two rounds' numbering in one sequence over overlapping paths — the exact
shape of the `M29` collision above. `API-01`–`API-22` are pinned one-to-one to the round's own
`M1`–`M22` labels; new ids start at `API-23` and only increase.

`baselineCommit`, `baselines` and `verifiedByThisRound` in the JSON still describe the v1.0.0 round
at `ac034a4` and do **not** include this set. Its numbers live in `sets[api].measuredInThisRound`.
Do not add the two together.

One correction to this section as it was first written: it said "Every entry carries `measured: true`."
No entry has a top-level `measured` field — the flag is on each item inside `killedBy`, where all
items across all entries do carry it. The substance was right and the sentence put it in the wrong
place.

## Added in v1.2.0 — `API-30` to `API-50` (the owner gate, structurally)

A scoped re-review attacked fix round 1's hardened guard with **15 constructions and eleven beat
it** — eight of them green on the contract check, `test:twi` and `typecheck:twi` at the same time.
The two worst needed no trickery at all:

```ts
if (segments[0] !== 'health') await requireOwnerSession(request, env);   // present, early, CONDITIONAL
```

and a sibling file `functions/api/twi/health.ts` with its own ungated `onRequest`, which Cloudflare
Pages prefers by path specificity while the gate sits in a file that is never entered. Both were
invisible because the guard was a **line scan over one file** — and the fact it needed to pin is
neither lexical nor positional. Round 2 replaced it with a parse (`scripts/lib/twi-route-structure.mjs`,
using the `typescript` devDependency) plus a recursive directory inventory. These 21 entries are the
record of what that closes.

- **21/21 killed** by the round-2 guard, measured at `fix/twi-gate-lock-structural` (base `df9af7a`),
  after reproducing that tree's baseline first (contract check 29, `test:twi` 353).
- **The prior guard was measured, not assumed.** `scripts/twi-contract-check.mjs` was extracted
  verbatim from `d441679` and run against all 21. `API-30`–`API-39` all survived it, which reproduces
  the re-review's table exactly and is the harness's own validation. Of the eleven invented in round
  2, **four** survived, **one** was mixed by spelling, and **six were already caught** — four of the
  six only because an `indexOf` anchor went to `-1`, not because anything asserted the fact. Each
  entry says which, rather than the set rounding all eleven up to "former survivors".
- **A guard that catches by accident is recorded as such.** `API-50` is the one construction round 1
  caught that round 2's first draft did not: renaming the `catch` binding. Round 1 caught it because
  `catchIndex` became `-1`; round 2 catches it as a stated fact (the catch must bind an identifier and
  the block must read it), so renaming consistently is now correctly allowed.
- **Four false-positive classes retired.** Correct code that round 1's guard rejected: a trailing
  comment containing "return" (on the preflight line *and* inside the gate), `return (await h(…));`,
  and `return cond ? await h(…) : json(…, 405);`. None is a mutant; they were the cost the line scan
  imposed on the next editor. Recorded in `measuredInFixRound2.falsePositivesRetired`.
- **`futureRunner`'s syntax gate now exists**, though not in a runner: the contract check asserts the
  route file *parses*, so a mutant that breaks the syntax is a parse failure rather than a scored kill.

Round 2's numbers live in `sets[api].measuredInFixRound2`; `measuredInThisRound` beside it is fix
round 1's. Do not add those two together either.

## Changed in v1.3.0 — no new ids, three corrections and one promise kept

A third adversarial re-review attacked round 2's guard with **23 constructions and 16 beat it**, ten
of them with `npm test`, `typecheck:twi` and the contract check simultaneously green. Fix round 3
closed all of them and added five more of its own. **No mutant ids were added**, and that is a
deliberate choice explained below. What changed here is honesty and enforcement.

- **Seven entries contradicted themselves, and now do not.** Round 2 corrected `status`,
  `notKilledBy` and `provenance` for the six mutants it measured as ALREADY KILLED at `d441679`
  (`API-40`, `API-41`, `API-43`, `API-44`, `API-49`, `API-50`) plus the one MIXED entry (`API-48`) —
  and left the *boilerplate* `premise.claim` asserting "MEASURED SURVIVOR" and a `crossCheck`
  claiming "exit 0 against the 29-check lexical version" for all seven. Both fields are now per
  entry and say what that entry's own three other fields already said. Two of the six
  (`API-44`, `API-49`) additionally record that the prior guard caught them **on its own terms**
  rather than incidentally, which the shared text also got wrong in the other direction.
- **`API-45`'s kill was over-attributed** to the `env` rule. Its payload carries a trailing
  `void purge;`, which is an independent offender as a bare statement above the gate; strip it and
  spell `env` as `ctx['env']` and the round-2 guard scored the same mutation **33/33 green**, because
  that rule was a rule about one IDENTIFIER. The entry now records both halves. Round 3 closes both:
  computed member access above the gate is refused, and the whole region must equal a declared
  preamble.
- **The `failureMode` on all 24 gate entries was true and is no longer.** It said that replacing the
  AST analysis with a line scan reverts every one of them to a survivor *while every unit test stays
  green* — and the re-review proved exactly that with a 14-line permissive stub: `npm test` 7/7, the
  contract check still reporting the same number of checks. `scripts/twi-route-structure.test.mjs`
  now drives the analysis directly, is wired into `npm test` as `test:twi:structure`, and takes **this
  manifest's own `exact-from-source` find/replace pairs as its corpus** — so each entry's prose
  premise is an executed assertion. Measured against the same stub: the contract check still passes,
  and that suite fails **41 of 58** tests, naming the mutants.

**Why round 3 added no ids.** Its 14 new constructions (a block-nested gate, a module-scope wrapper
keeping the gate's name, a catch that serves the resource, `ctx['env']` and `ctx[key]`, a renamed
destructuring, `export * from`, an ancestor `_middleware` at three levels, a parent-level `twi.js`, a
`_worker.js`, a `_routes.json` exclusion, a bare public marker, a public `_middleware`) are registered
as **named tests** in `scripts/twi-route-structure.test.mjs` rather than as JSON prose. A test that
runs is strictly stronger than a manifest entry that does not, and this file's own
`testCommandWarning` exists because so many entries are text-only facts no suite can see. The
constructions are documented in `.superpowers/sdd/2026-08-16-twi-creation-core/task-5-fix-round3-report.md`
with their before/after measurements; if a runner is ever built, they can be lifted into ids then.

## No runner, deliberately

The owner chose a manifest, not an executable suite. The format is shaped so a runner can consume
it later without a rewrite; `futureRunner` in the JSON lists what one would need — chiefly a syntax
gate (a mutated file that no longer parses must be `INVALID`, not `KILLED`; group-e reported a false
79/79 for exactly that reason), an anchor-uniqueness precheck, a green-baseline gate, and per-mutant
rather than per-set kill suites. The reason not to build it yet is not difficulty: a runner over a
manifest with four unapplicable entries and eight aggregate groups would report confident numbers
over an incomplete set, which is the failure this file exists to stop.
