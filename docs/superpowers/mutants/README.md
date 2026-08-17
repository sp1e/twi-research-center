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
| `id` | Stable, namespaced, never reused: `DOM-*` domain, `SCH-*` schema, `REPO-*` repository, `APP-*` app shell, `MIG-*` migration tooling. |
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

## No runner, deliberately

The owner chose a manifest, not an executable suite. The format is shaped so a runner can consume
it later without a rewrite; `futureRunner` in the JSON lists what one would need — chiefly a syntax
gate (a mutated file that no longer parses must be `INVALID`, not `KILLED`; group-e reported a false
79/79 for exactly that reason), an anchor-uniqueness precheck, a green-baseline gate, and per-mutant
rather than per-set kill suites. The reason not to build it yet is not difficulty: a runner over a
manifest with four unapplicable entries and eight aggregate groups would report confident numbers
over an incomplete set, which is the failure this file exists to stop.
