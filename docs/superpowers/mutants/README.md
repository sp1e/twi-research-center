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
| `id` | Stable, namespaced, never reused: `DOM-*` domain, `SCH-*` schema, `REPO-*` repository, `APP-*` app shell, `MIG-*` migration tooling, `API-*` the authenticated API surface, `PUB-*` publication guards, `FIN-*` Modal finishing, `PCS-*` provider-call state. |
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

`baselineCommit` and `verifiedByThisRound` in the JSON describe the v1.0.0 round at `ac034a4` and do
**not** include this set. Its numbers live in `sets[api].measuredInThisRound`. Do not add the two
together. (`baselines` also described only v1.0.0 until v1.4.0 added `baselines.currentAtHead`
beside it — see that section below.)

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

## Changed in v1.4.0 — the `baselines` block stopped being true, and now says so

Data only. **No mutant entry was touched**: 138 entries, 138 unique ids, and `sets`,
`verifiedByThisRound`, `uncertainty`, `futureRunner` and `headlineMutationScores` are byte-identical
to v1.3.0.

`baselines` carried the v1.0.0 round's suite numbers — `ALL SUITES PASSED (6/6)`, `test:twi` 262 over
13 files — and three revisions went past it without either refreshing or labelling them. By `1da7968`
there were **eight** suites and `test:twi` was **353 over 19 files**, and the two script-check suites
(`test:twi:contracts`, `test:twi:structure`) did not appear in the block at all. Read at face value it
was a tracked document asserting figures that had stopped being true — the failure this manifest was
created to stop.

The v1.0.0 numbers are **kept**, for the same reason a retired mutant is kept: they are what a
mutant measured by that round was measured against. What changed:

- `baselines.readThisFirst` states in the file that `measuredAt` / `npmTest` / `suites` are history.
- `baselines.currentAtHead` records the suite **measured at `1da7968`** on a clean tree, per suite,
  read off one `npm test` run: legacy 128, sp1epacker 149/8, twi 353/19, schema 39,
  **structure 58 (new)**, contracts **38 checks**, migrations 10, bundle 8 checks — 8/8 green,
  737 tests plus 46 script checks, with both typechecks and the build green and
  `git status --porcelain` empty afterwards.
- `baselineCommitNote` says `baselineCommit` is an **anchor** fact that does not move, not a claim
  about the current suite. Those two had been read as one thing.

`currentAtHead` is the suite, **not a score**. No round has applied the combined 138-entry set
against `1da7968` or against any other single commit; `uncertainty` still governs that.

## Changed in v1.5.0 — the `baselines` block is now executed, not asserted

v1.4.0 corrected the figures by hand. That fixed the value and not the class: a hand-measured
baseline is stale again the moment a test is added, and the reason the block went wrong for three
revisions was never that someone mistyped a number — it was that **nothing ran it**.

So `npm test` now measures the suite and holds this file to it. `scripts/run-tests.mjs` captures each
suite's output instead of letting it stream past unread, reads back the count the suite printed about
itself, and after the suites calls `scripts/lib/mutant-baselines.mjs`. Any disagreement fails the run
naming the JSON path, the recorded value and the measured one:

```
MANIFEST BASELINE DRIFT (1) — docs/superpowers/mutants/twi-creation-core.mutants.json

  baselines.currentAtHead.suites["test:twi"].tests
      recorded: 352
      measured: 353
```

- **What is compared:** every figure `currentAtHead` asserts — per-suite `tests` / `files` /
  `checks`, `test:legacy`'s `composition` array, the suite roster in **both** directions, `npmTest`'s
  `(N/N)` and both sums in `totals`. Prose (`note`, `gates`, `whatThisIsNot`) is not compared.
- **What is not compared, deliberately:** the v1.0.0 block. It is history. Rewriting history to match
  today is the failure being closed, not the fix for it.
- **Adding tests is not a chore.** The gate is exact in both directions, because the drift nobody
  noticed was an *increase* — but `npm test -- --update-baselines` applies the corrections in place,
  a surgical single-line edit per figure that leaves this 353 KB file's formatting alone. A gate you
  have to hand-edit around is a gate people learn to route around, which is worse than none.
- **The flag cannot launder a deletion.** Each suite also declares a count **floor** in
  `scripts/run-tests.mjs`, checked the moment that suite finishes; `--update-baselines` is
  unreachable while any floor is breached. So it records growth and only growth.

Why the floors exist at all, beside this: `node --test` on a file with no tests in it reports the
**file** as one passing test and exits 0. An emptied `scripts/twi-schema-behavior.test.mjs` used to
take `test:twi:schema` from 39 to 1 with `npm test` still green — the 227-tests failure, still live.
It now fails with `process 1 of 1 in the chain: 1, floor is 39`.

One figure the runner tracks that this file does not: `test:legacy`'s **199** `ok`-lines across its
chained contract-check scripts. There are **eight** of those scripts, not six — v1.4.0's note on
`test:legacy` said six, and the note is corrected. None of the eight prints a total of its own, so
there is no count of theirs to record here and the floor lives only in the runner. The six figures in
`composition` are the six `node --test` processes, which is a different thing and was being read as
the same one.

## Added in v1.6.0 — `API-51` to `API-74` (Task 6, image-reference ingestion)

Task 6 is the first task to add a route since the gate settled into equalities, and the first to
write bytes to R2. Twenty-four mutants were **applied and reverted**, not transcribed:
**24/24 killed**, measured on `feat/twi-task6-asset-ingestion` (base `e602840`) after reproducing
that tree's eight-suite baseline first. (This paragraph said twenty-three, and the heading said
`API-73`, until v1.7.0 corrected both: `API-74` was added late in that round and the JSON's own
`liveCount` and `measuredInTask6.score` always read 74 and 24/24.)

Read three things about this set before using it.

- **None of them is a former survivor, and that is a different claim from the earlier sets'.** Every
  previous `API-*` entry records a guard being beaten and then closed. These were written by the
  round that wrote the code, so what they measure is whether the tests shipped *alongside* an
  implementation can detect that implementation being wrong. That is weaker evidence than an
  adversarial round's, and it is the honest description of it.
- **Two of the behaviours are ORDERS, not values, and a status assertion cannot see them.** The
  10 MiB cap must precede the byte read (`API-54`), and the declared-length refusal must precede
  `request.formData()` (`API-56`). Under both mutations the request is *still refused with the same
  status* — it just costs the memory or the parse first. The kill signal is a test double that
  refuses to produce the expensive thing: a file whose `slice()`/`arrayBuffer()` throw, and a
  `Request` whose `formData()` counts its calls. If those doubles are ever replaced with real
  `File`s "for realism", both mutants revert to survivors with every assertion green. Both are also
  killed independently by `scripts/twi-contract-check.mjs`, which compares the two positions in a
  comment-free canonical AST rendering — measured separately, not assumed.
- **`API-62` exists because mutation testing found a gap, and the gap is the interesting part.**
  `registerAsset` returns `{ asset, outcome }`; discarding the outcome and answering `201`
  unconditionally left the **whole suite green**, because the `outcome` field in the body was still
  correct and no test drove a replay through the route. Reading an outcome is not using it. A test
  was added (`answers 200, not 201, when the registration was a replay rather than a write`) and the
  mutant then died.

Two further notes, both recorded in the JSON rather than only here:

- **A measurement was corrected.** The first harness kept its backup as a `.mutbak` sidecar beside
  the file it mutated — which, under `FUNCTIONS_REGISTRY`, is an undeclared file under `functions/`.
  The registry refused it, exactly as designed, and two registry checks therefore appeared in the
  kill lists of `API-70` and `API-72` with no causal relation to either mutation. Both were
  re-measured with the backup outside the repository and the spurious checks are **not** recorded.
  Rule 9 of the working agreement warns that a mutation which fails to apply looks like a kill; this
  is the same error in the other direction, and it inflates a guard rather than hiding a hole.
- **`appliesAtCommit` carries a branch name, not a sha.** These entries ship in the *same* commit as
  the code they target, so the sha did not exist when they were written — a first for this manifest.

Registering `API-70` and `API-72` also grew `test:twi:structure` from **58 to 60 tests** with no edit
to that suite: its corpus is this file's own `exact-from-source` route mutations, so a new route-file
entry whose `killedBy` names a structural check becomes an executed assertion automatically.

`measuredInTask6` in the JSON holds this round's numbers. **Do not add it to `measuredInThisRound`
or `measuredInFixRound2`.** And 24/24 is not a coverage claim about Task 6: it says these 24
behaviours have a discriminating test, not that every behaviour does — and v1.7.0 below is the
list of what it did not cover. The known limitation is in
`.superpowers/sdd/2026-08-16-twi-creation-core/task-6-report.md` — the upload endpoint does not cap
how many image references a project may accumulate, because counting them needs a repository read and
`src/twi/server/repository.ts` belongs to Task 7.

**One thing this round did not fix:** the README already had a `Changed in v1.5.0` section, but that
round left `manifestVersion` at `1.4.0` and added no `revisions` entry. Rather than claim to be
v1.5.0 or renumber another round's work, this one took `1.6.0` and recorded the gap in
`revisions[].versionNote`. The missing 1.5.0 entry is an open item.

## Added in v1.7.0 — `API-75` to `API-88` (Task 6 fix round 1, the classes gate 2 named)

Task 6 passed both gates with 24/24 killed, and gate 2 then wrote down what those 24 could not see.
This section is that list, closed. **14/14 killed**, applied and reverted at
`fix/twi-task6-hardening` (base `e9280b6`), with backups kept OUTSIDE the repository — the mistake
v1.6.0 recorded, where a `.mutbak` sidecar under `functions/` produced two spurious registry kills.

The five gaps, and the entries that answer them:

| Gap gate 2 named | Entries |
|---|---|
| Nothing exercises a real request stream | `API-75`, `API-76` |
| No entry touches the malformed-multipart path | `API-77` |
| No entry probes retry/duplication | `API-78`, `API-79`, `API-80`, `API-81`, `API-82` |
| No entry on the degenerate-`size` guard | `API-83` |
| Weakening rather than removing | `API-84` (`startsWith` → `includes`), `API-85` (`toLowerCase()` dropped), `API-86` (the raw boundary lowercased), `API-76`, `API-82` |

Three things worth reading before using the set.

- **Three of them are not hypothetical.** `API-75` (the body buffered in full before the refusal),
  `API-77` (a malformed body answered 500) and `API-78`/`API-79` (a retry writing a second object and
  a second row) *are* the code as shipped at `e9280b6`. Gate 2 measured that behaviour — 10,485,885
  bytes pulled before a 413, and 500 `internal_error` for a missing boundary. So these entries record
  a real defect reduced to one line each, which is stronger evidence than a hypothetical edit.
- **The weakening class needed new ACCEPTANCE cases, not new rejections.** Deleting a guard breaks a
  rejection and any rejection test catches it. `startsWith` → `includes` passes every rejection the
  suite had, because none of them contained the string; dropping `toLowerCase()` breaks *acceptance*,
  which no rejection test can see. Hence `application/json; note=multipart/form-data` → 415 and
  `MULTIPART/FORM-DATA` → 201, both new.
- **`API-88` is the one killed by the contract check, and it typechecks clean.** It inlines the
  ingestion into the handler, keeping 97 of 99 tests green while losing the compensating delete. That
  is gate 1's Minor 2 measured: before the assertion was added, the same bypass kept all 52 checks
  green. `neither suite is sufficient` in this set's `testCommandWarning` now has a Task 6 example.

**One existing entry was edited, and re-measured rather than re-pinned on paper.** `API-62`'s anchor
was `return json({ asset, outcome }, outcome === 'inserted' ? 201 : 200);`. The fix moved that
statement into a module-level `assetResponse` helper so the idempotency replay and the fresh insert
mint their status in the same place — which is also what keeps the mutant killable, since the replay
no longer reaches the handler's final line. The anchor lost its leading `return `, the mutation was
applied at the new tree, and both kill signals were measured: 3 failed / 96 passed, and 1 of 52
contract checks. `mutation.anchorRepinnedIn` records it.

**Three anchors in this file were already stale at `e9280b6` and are NOT this round's doing:**
`DOM-09` and `DOM-32R` against `src/twi/domain/schemas.ts`, and `API-21` against
`scripts/run-tests.mjs`. The same uniqueness check run against the base commit's own blobs reports
the same three. They are recorded in `revisions[1.7.0].alsoRecorded` rather than quietly fixed:
repairing them means re-measuring against files this round does not own. **All three were repaired
in v1.8.0**, each re-measured; see that section for the numbers.

## Added in v1.8.0 - `API-120` to `API-124` (Task 6 fix round 2, the concurrency the suite could not see)

The scoped re-review of fix round 1 confirmed all four earlier findings closed and then raised three
new Importants, all three in `src/twi/server/assets.ts` and all three consequences of one change:
deriving the asset id from the client's `Idempotency-Key` made the R2 object key **shared** between
concurrent requests. **5/5 killed**, applied and reverted at `fix/twi-asset-race` (base `8e6f289`),
backups outside the repository, each target verified byte-identical afterwards.

| Entry | What it does | Result (`npx vitest run --config vitest.twi.config.ts`, 441/21) |
|---|---|---|
| `API-120` | the compensating delete stops asking who owns the object | KILLED 2 failed / 439 passed |
| `API-121` | the put stops being conditional (`onlyIf` dropped) | KILLED 2 failed / 439 passed |
| `API-122` | the identity preimage goes back to newline-delimited fields | KILLED 1 failed / 440 passed |
| `API-123` | a refused conditional put is treated as a success | KILLED 1 failed / 440 passed |
| `API-124` | the unknown-owner case (a failed lookup) deletes anyway | KILLED 1 failed / 440 passed |

**Why the numbering jumps from `API-88` to `API-120`.** Task 7's salvage was adding `API-*` entries to
this same file at the same time, and both rounds would otherwise have claimed `API-89`. `API-89` to
`API-119` are **reserved by gap** for it, so the two sets cannot overlap whichever merges first. The
gap is not a deletion - `retiredCount` is still 0 - and `sets[api].idCollisionAvoidance` records the
convention: a concurrent round reserves forward rather than negotiating for the next free id.

All five typecheck clean (`npm run typecheck:twi` exit 0 under each), which is the point: none of them
is visible to anything but a behavioural assertion. Three things worth reading before using the set.

- **The suite could not see any of this, and the reason is a KIND rather than a gap.** Every test in
  `src/twi/server/asset-ingestion.test.ts` was single-writer, and a single writer's compensating delete
  can only ever touch its own object. `API-120` and `API-121` therefore depend on a genuinely concurrent
  test - two overlapping uploads over one real repository, held at a barrier so both replay lookups
  really miss rather than being stubbed to. Both entries carry that in `premise`.
- **`API-120`, `API-121` and `API-122` are the code as shipped at `8e6f289`.** Each one's
  `mutation.isThePreFixCode` records the measured consequence: the winner's object deleted and one row
  left pointing at absent bytes; a surviving row whose `sha256`/`bytes` (8 bytes, `9720c604...`) describe
  an object that holds 10 bytes hashing to `df5aa251...`; and two distinct `(projectId, key)` pairs
  deriving one uuid. The re-review measured that uuid as `d06e617a-b115-86df-a075-fd8b340ab9b8`; under
  `API-122` it comes back as `a1e0189c-fc48-89e6-880e-b1ceb27af703`, because the fix also bumped the
  identity domain constant to `v2`. Same collision, different domain string - worth knowing before
  matching a uuid against the re-review by eye.
- **`API-123` needs the SINGLE-writer orphan case, not the race.** In the race the D1 collision backstop
  answers the same 409 either way, so the race alone leaves it alive; what discriminates is an object
  under the key with no row naming it. Recorded in its `premise`, because it is the one entry here whose
  kill signal is not the obvious test.

**SIX existing anchors were repaired, and every one was RE-MEASURED rather than re-pinned on paper.**
Three were the pre-existing stale anchors the v1.7.0 entry recorded; three more were broken by this
round's own source change, two of those without anyone noticing until the audit below ran.

| Anchor | Why it went stale | Re-measured |
|---|---|---|
| `API-21` | named the `['test:twi:contracts', '<blurb>'],` tuple `scripts/run-tests.mjs` stopped using when `SUITES` became objects with `shape` and `floor`. Dead at `e9280b6` **and** `8e6f289` | contract check fails **1 of 52 by name** |
| `DOM-09` (site 2) | `sound.imageAssetIds` became `boundedArray(uuid, 10)` at `b69678b`, so the field line the site anchors on changed while the `}).strict(),` it guards did not | **1 failed / 440 passed** |
| `DOM-32R` | anchored the array-stage `.max()` that `b69678b` **lifted out** in front of the array | **15 failed / 426 passed** |
| `API-60` | RR-1's ownership guard moved the compensating delete one nesting level deeper | **2 failed / 439 passed** |
| `API-61` | RR-2 made the put conditional, so the one-line put became four lines plus a guard | **11 failed / 430 passed** |
| `API-80` | RR-3 length-prefixed the preimage, so the line it anchors changed | **2 failed / 439 passed** |

Four of those deserve a sentence each.

- **`API-21` was the only mutant covering contract-check sections 10 and 11**, so while its anchor was
  dead that section had no applicable kill signal at all - which is why repairing it was worth a round
  that does not otherwise own `scripts/run-tests.mjs`. Its `killSuiteWarning` needed correcting too.
  The new anchor is the whole `SUITES` entry, comments included, because **removing the entry is the
  mutation** - and quoting a comment is exactly how the old one died, so the entry now also carries a
  comment-independent `mechanicalRule` that a runner should prefer.
- **`DOM-32R`'s post-restructure form was recorded as `not-recoverable`**, on the ground that guessing
  might record `DOM-37R` twice under two ids. That objection is now settled by measurement rather than
  by argument: removing the pre-bound from `normalizedList` alone gives 15 failed / 426, `DOM-37R`
  defeating the shared predicate gives **19 failed / 422**, and the four tests between them are exactly
  the `boundedArray`/`imageAssetIds` arm the scoped edit leaves intact. Demonstrably different edits.
- **`API-80`'s repair was attempted once and got the escaping wrong.** The source holds the two
  characters `\\` and `n` inside a template literal, so the JSON must spell it with a
  **doubled** backslash; the single form decodes to a real newline and matches nothing. Measured: 0
  occurrences, under an entry that claimed a re-measurement it therefore cannot have made. If you
  hand-edit an anchor in this file, count the backslashes and then run the audit.
- **`API-60` and `API-61` are the reason the audit exists.** A stale anchor keeps every test, every
  typecheck and every contract check green - it fails silently by construction - so a round that edits
  a target file can break an anchor and ship. The audit is ~30 lines: read every `mutation.find`
  (multi-site aware) and count occurrences in `target.file`.

```
whole-file anchor audit          at 8e6f289  : 161 sites, 3 stale   (DOM-09 site 2, DOM-32R, API-21)
                                 after v1.8.0: 166 sites, 0 stale
```

`futureRunner.stillNeeded` already asks for this as an ANCHOR-UNIQUENESS PRECHECK at apply time. The
lesson of this round is that it is *also* needed as a regression check on every round that touches a
target file. **`test:twi:structure` is not that check:** it executes this manifest's anchors as a
corpus for the **route file only**, so anchors on the other target files rot with nothing watching.
Out of scope here, recorded so it is not lost.

## Added in v1.8.0 — `API-89` to `API-115` (Task 7, the creation-job money path)

Task 7 is the first task whose **every** route either spends provider money or acts on a job that
already did: estimate, idempotent submit, poll, cancel, retry. Twenty-seven mutants were **applied
and reverted**, not transcribed, on `feat/twi-task7-submit` (base `8e6f289`) after reproducing that
tree's eight-suite baseline first.

The headline is two numbers, and they must not be collapsed into one:

- **23/27 killed** against the suite as inherited (55 tests across `jobs.test.ts` and
  `jobs-lifecycle.test.ts`).
- **27/27 killed** after this round added 13 tests to close the four survivors.

**The four survivors are the point of this set.** Unlike `API-51`–`API-88`, this round did not write
the code — it inherited it from an implementer whose process died before the mutation round it owed,
with the work uncommitted. So these entries record a guard actually being beaten:

| id | survived because | closed by |
|---|---|---|
| `API-102` | the list only ever held three jobs, so raising the page bound to `Number.MAX_SAFE_INTEGER` changed nothing observable | `asks the repository for exactly MAX_JOB_PAGE, never a caller-supplied bound` |
| `API-112` | the estimate cost row was only ever **counted**, never **valued** — charging it at `0` kept every count right | `records on the job the SAME total the estimate route quotes, before anything is dispatched` |
| `API-114` | cancel was only ever driven from `queued`, so hardcoding `fromStatus: 'queued'` was indistinguishable from reading it | `cancels a job in generating / ingesting / finishing` |
| `API-115` | nothing drove a cancel from `validating`, so replacing `canTransition` with a transcribed list admitted one silently | `refuses to cancel from validating, which the state machine does not admit` |

They share one shape: **each is a branch the inherited suite exercised at exactly ONE of its admitted
inputs.** That is the same failure shape as Task 6's idempotency gap and as the 227 tests that never
ran — the branch exists, is correct, and nothing drives the other cases through it. A count is not a
value, and one legal input is not a domain.

Two further entries carry a `premise` worth reading before trusting them:

- **`API-110` is the honest answer to a claim the implementer made in prose.** It reported placing
  the ten-reference cap on the raw body *ahead of* the parse, and offered as proof a test counting
  **zero repository reads** for an over-count. That test does **not** discriminate the placement: a
  post-parse cap is unreachable anyway (`rawEntryCountBound(10)` inside `boundedArray` refuses the
  eleventh entry first) and that parse failure *also* precedes every repository read, so zero reads
  holds under both arrangements. Measured: the mutation that moves the cap below the parse fails
  exactly one test, and it is the one asserting the refusal **code** `too_many_image_references`. The
  reasoning was right; the cited proof was not the proof.
- **`API-113` targets `src/twi/server/queries.ts`, which Task 7 does not own.** The `category =
  'estimate'` literal is Task 4 code, and it is registered here because Task 7 is the first caller
  whose money rule depends on it — `actual_cost_usd` is recomputed as
  `SUM(amount_usd) WHERE category <> 'estimate'`, so a drifted category charges the owner on
  submission. It is the one of the four estimate/actual-cost mutants the inherited suite already
  caught, which is why it is **not** listed as a survivor beside `API-112`.

Do not add `measuredInTask7`'s figures to `measuredInTask6`, `measuredInThisRound` or
`measuredInFixRound2`. Same rule as always, same reason.

## Added in v1.9.0 — `API-116` to `API-119` and `API-125` to `API-136` (Task 7 fix round 1)

Gate 2 **BLOCKED** Task 7. Sixteen mutants were applied and reverted on `fix/twi-task7-hardening`
(base `1e5d4c3`) against the four job suites (86 tests: `jobs.test.ts`, `jobs-concurrency.test.ts`, `jobs-lifecycle.test.ts`, `jobs-dispatch.test.ts`): **15 killed, 1 recorded as a known
equivalent survivor.** Every one was restored with a byte-identical check and `git status --porcelain`
was empty after the pass.

**Ids.** `API-116`–`API-119` are the four RESERVED-BY-GAP at Task 6 fix round 2 for Task 7 and never
spent; this round spends them and then continues at `API-125`. The gap between 119 and 125 is now
closed and no id was reused.

**Three of the sixteen are revert-proofs of behavioural fixes** — the mutation IS (or reproduces) the
code as shipped at `1e5d4c3`:

| id | the defect it restores |
|---|---|
| `API-116` | two concurrent submits of one `Idempotency-Key` answer **500 `internal_error`** instead of replaying, because `estimatedJobMatchesInput` requires the same job id AND spec id and `submitJob` mints both per request — so `outcome === 'replayed'`, the branch the module header calls contract 3, was **unreachable in production**, and its only test supplied the outcome through a `repoWith` override |
| `API-117` | the `spec_digest_mismatch` exit leaves the `twi_generation_specs` row it just wrote |
| `API-118` | the losing concurrent submit leaves the same orphan — measured at `1e5d4c3` as `specs = 2, jobs = 1`, each orphan a full copy of the lyrics the owner typed, with nothing to reap it |

**Nine are coverage defects that gate 2 measured as SURVIVORS of all 523 tests, all 79 contract checks
and `typecheck:twi`** — the live code was already correct and nothing could tell:

| id | gate 2 label | the claim nothing tested |
|---|---|---|
| `API-119` | HUNT-A | the attempt ordinal **on the wire**, pinned inside `event_key` and unpinned in the payload Task 8 reads |
| `API-125` | HUNT-B | `cancelJob`'s ordinal — under the mutant a cancel of a retried job reuses `…:0:cancelling` and silently replays **after** the stop request was sent |
| `API-126` | HUNT-F | `provider` attribution, bound into the job row **and** the estimate cost row |
| `API-127` | HUNT-K | the `accepted: false` audit marker on a refused dispatch |
| `API-128` | HUNT-L | `failDispatch`'s read-back status, whose comment claims a concurrent writer cannot break it |
| `API-129` | HUNT-I | `MAX_REPORTED_ISSUES` |
| `API-130` | HUNT-M | `MAX_ISSUE_TEXT` |
| `API-131` | HUNT-N | `listJobs`' `trim()` — `?projectId=%20` became a 500 |
| `API-132` | HUNT-G | `encodeURIComponent` on the cancel URL (judged *equivalent* at `1e5d4c3` because every fixture id is a UUID; the round wrote a job whose id needs encoding rather than leaving the claim to the fixtures) |

Their `provenance` says survivor-then-closed rather than presenting them as tests agreeing with code
shipped beside them. **`API-133`** is a regression guard for the configured-`TWI_LYRIA_ESTIMATE_USD=0`
falsehood and is the one entry killed by **two** independent signals, measured separately: a unit test
and a contract check. **`API-134`** and **`API-135`** defend two constructs this round introduced — the
reap's `NOT EXISTS` guard and the list answer's `mayHaveMore`.

**`API-136` is recorded as a `known-survivor` and that is the honest verdict, not a gap.** It drops the
attempt ordinal from `costKey`, and it is an equivalent mutant at this tree: exactly one estimate cost
row is ever written per job and `twi_cost_events` is `UNIQUE (job_id, idempotency_key)`. Its
`whenItBecomesKillable` names the change that makes it real — any path writing a second estimate row —
so whoever adds that path inherits the test they owe.

**One existing entry's citation was edited, and nothing was weakened.** `API-20`'s only kill signal is
contract-check section 6, whose NAME was false after Task 7 (`the TWI Pages Function graph exists and
imports no npm package`, while the real graph reaches `zod` and the check covers an enumerated subset
of eight modules). The name is now `the 8 enumerated TWI Pages Function modules exist and import no
npm package`; the **predicate is unchanged**; the check count is unchanged at 79; the other 78 names
are byte-identical in the same order, verified by executing the script before and after and diffing
the printed names (`25c25`, one removed, one added). The check was **not** removed, because the section
13 walk does **not** subsume it: `ADMITTED_PACKAGES` contains `zod`, so a bare `import { z } from
'zod'` in the route file passes the walk. `API-20` was re-applied after the rename and is still killed
by exactly that one check.

Do not add this round's 15/16 to `measuredInTask7`, `measuredInTask6`, `measuredInThisRound`,
`measuredInFixRound2` or `measuredInTask6FixRound2`. Same rule as always, same reason: different
commit, different suite size.

## No runner, deliberately

The owner chose a manifest, not an executable suite. One qualification since v1.3.0:
`scripts/twi-route-structure.test.mjs` (`npm run test:twi:structure`) does apply this file's own
`exact-from-source` payloads for the gate entries, so those entries' `premise` prose is an executed
assertion. That is a corpus, not a runner — it asserts the analysis still reacts to each payload; it
does not score the set. The format is shaped so a runner can consume
it later without a rewrite; `futureRunner` in the JSON lists what one would need — chiefly a syntax
gate (a mutated file that no longer parses must be `INVALID`, not `KILLED`; group-e reported a false
79/79 for exactly that reason), an anchor-uniqueness precheck, a green-baseline gate, and per-mutant
rather than per-set kill suites. The reason not to build it yet is not difficulty: a runner over a
manifest with four unapplicable entries and eight aggregate groups would report confident numbers
over an incomplete set, which is the failure this file exists to stop.
