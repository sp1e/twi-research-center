# Task 11 handoff — connect the Workflow to Modal finishing

**Written 2026-08-30.** Tasks 5–10 are CLOSED. Task 11 is next and **not started** — no Task 11
code exists yet. This file exists so the next session can be a different account, or a
different machine, and lose nothing.

---

## 0. Orient yourself before trusting anything below

Run these four and compare. If they disagree with this file, **this file is stale and the
repository wins.**

```bash
cd <sp1e.se checkout> && git log --oneline -1 && git status -sb | head -1
npm test
git ls-remote https://github.com/simonpsson/twi-research-center.git main
python docs/superpowers/mutants/harnesses/task10_finish_mutants.py
```

Expected at the time of writing:

| Thing | Value |
|---|---|
| Source branch | `codex/twi-research-center-design` |
| Source branch tip | the commit that added **this file**, on top of `6caa9bb`. `git log --oneline -1` therefore shows a LATER hash than `6caa9bb` — that is expected, not drift. Tree clean, in sync with origin. |
| Mirror | synced from the same commit; re-sync after every landing |
| Gate | **ALL SUITES PASSED (11/11)** |
| Totals | **1017 tests plus 102 script checks** |
| Task 10 harness | 12/12 killed |

The `npm test` totals line is the one that matters. It is the only claim in this document
that a machine checks.

## 1. Where everything actually is

Three checkouts exist and they are **not** interchangeable:

| Path | What it is |
|---|---|
| `…/Documents/Codex/2026-08-15/new-chat/work/sp1e.se` | **the canonical source repo.** Work here. |
| `…/Documents/Codex/2026-08-15/new-chat/work/twi-research-center` | **the live mirror clone** — the one `sync:twi-mirror` actually writes to, because the script defaults to `<source>/../twi-research-center`. **Never hand-edit.** |
| `…/Claude/twi-research-center` | a STALE second mirror clone, last synced 2026-08-19. The sync script never touches it, so its tip lags and reading it will misreport the mirror's state. Verify the mirror with `git ls-remote …/twi-research-center.git main` rather than any local clone. |
| `…/Documents/Codex/2026-08-15/new-chat/work/twi-verify/*` | task worktrees, incl. the research branch |

The deep-research documents (`TWI-AUDIO-AI-DEEP-RESEARCH-2026-08-30.md` and
`research/report-source.md`) live **only** on the research worktree
`twi-verify/twi-research-codex`, not in the source repo. §5 quotes everything from them that
Task 11 needs, so you do not have to find them — but if you want the primary sources, that is
where they are.

`.superpowers/sdd/2026-08-16-twi-creation-core/progress.md` is the blow-by-blow ledger. It is
**gitignored and machine-local** — it does not travel between machines. If you are on a new
machine it simply does not exist, and this file plus `HANDOVER.md` are the record.

## 2. The two-repository rule — non-negotiable

Every landing updates **both** repositories:

```bash
npm test                     # must be 11/11 before anything else
git push
npm run sync:twi-mirror      # filters + verifies + pushes the private mirror
```

`sync:twi-mirror` refuses to carry a file whose name has no `twi` in it unless the path is
listed in `SUPPORT_PATHS` in `scripts/twi-mirror-sync.mjs` **and** in
`scripts/twi-mirror-paths.txt`. If you add a TWI-owned file with a neutral name (as Task 10
did with `stems-gpu/finish.py`), you must add it to both or the sync fails the leak check.

## 3. What Task 11 has to build

The plan section is `docs/superpowers/plans/2026-08-16-twi-creation-core.md`, "Task 11". Read
it, **then read §4 and §5 here**, because three things in it are wrong or superseded.

Shape, from the plan:

```ts
const call = await step.do(`submit-finish-${label}`,
  { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
  () => submitFinish(...));
const result = await step.waitForEvent(`wait-finish-${label}`, {
  type: `modal-finished-${label}`, timeout: '30 minutes',
});
await step.do(`validate-${label}`, () => validateFinishManifest(call, result.payload));
```

Definition of done: one finishing job per candidate, an event per candidate, manifest
validation, publication refused if either callback is missing or invalid, a duplicate
callback is a no-op, and `/callback/modal` authenticated before it can `sendEvent`.

## 4. Corrections that apply to Task 11

### 4a. The plan's loudness gate contradicts what Task 10 shipped

Plan Step 4 says: *"Require master FLAC and MP3 preview, positive duration/bytes,
`-1.5 <= truePeakDbtp <= -0.5`, and `-15 <= integratedLufs <= -13`."*

Three problems.

1. **Naming.** Task 10 produces `archive.flac` and `review.mp3`, not "master" and "preview".
   The word *master* was deliberately removed — see §4b.
2. **The true-peak range disagrees with the shipped code.** `stems-gpu/finish.py` enforces
   `true_peak_dbtp <= REVIEW_MAX_TRUE_PEAK_DBTP` (`-1.0`). The plan's range would **accept**
   `-0.7`, which `finish.py` already **rejects**, and would **reject** `-2.0`, which
   `finish.py` accepts and which is perfectly fine. Do not implement the plan's range.
   Re-validate against the same constants `finish.py` exports, or you will have two
   disagreeing gates on the same object.
3. **Never apply a loudness gate to the archive.** `-15 <= integratedLufs <= -13` must apply
   to the **review only**. A quiet, wide-range archive is a legitimate archive. `finish.py`
   deliberately records `archive.loudness_target_lufs = None`, and mutants F1/F2/F10 in
   `docs/superpowers/mutants/harnesses/task10_finish_mutants.py` exist to catch anyone
   putting a target back on it. If those mutants ever survive, the archive is being mastered.

### 4b. Three renditions, one purpose each

| Object | What it is | Loudness |
|---|---|---|
| `raw.wav` | the provider's bytes, never rewritten | measured only |
| `archive.flac` | lossless conversion of raw | **measured, never targeted** |
| `review.mp3` | 320 kbps, blind A/B only | matched −14 LUFS, max −1 dBTP |

Loudness matching exists so a blind A/B cannot be won by being louder. That is a listening
aid, not a master.

### 4c. `finishing_not_implemented` is Task 11's to remove

`twi-orchestrator/src/providers/select.ts` has:

```ts
const FINISHABLE_MODES: ReadonlySet<string> = new Set(['fake']);
```

`/start` and `load-job` both refuse any mode not in that set, **before** the first billable
call, because this build could generate two candidates, bill for them, and then fail at
`finish`. Task 11 is what makes `'lyria'` finishable. Add it **only** when the Modal path
genuinely completes end to end, and note that `canCompleteRender` is covered by a mutant.

### 4d. The Lyria response envelope is UNVERIFIED

Endpoint and model are confirmed against primary sources. The `model_output` / `audio` block
shape is **not** — no source pins it. `lyria.ts` walks every step, treats zero audio blocks as
invalid and two as ambiguous rather than guessing.

**Task 11 must run a secret-gated manual live canary before anyone trusts this against real
billing.** Never in default CI. It should confirm: the real envelope shape, the actual WAV
sample rate (Google's own pages conflict between 44.1 and 48 kHz), duration adherence, the
safety-refusal marker, and the charge/retention behaviour on the paid project.

## 5. Security requirements for `/callback/modal`

From the research, and currently **fail-closed on purpose** — the route exists but refuses
everything. Before it may call `sendEvent`, it must validate **all** of:

- the shared secret (`X-Stems-Secret`) — proxy/application auth
- a replay **timestamp** and a **nonce**
- a **unique callback ID**
- that the callback binds **job, attempt, candidate label, asset prefix and the Modal call ID**
  it is answering — a callback that does not name the exact call identity is not evidence

**Store the callback ID in the event key, not in `detail_json`.** The plan's own shipped-state
correction says this and it is right: `twi_job_events.event_key` is `NOT NULL` with
`UNIQUE (job_id, event_key)` and no default, so a replayed callback is refused *by the
database* rather than detected by parsing JSON. `transitionJob` reports `outcome: 'replayed'`,
which is how the route returns 200 without emitting a second event. Same for cost rows via
`twi_cost_events.idempotency_key`. `detail_json` must remain a JSON **object**
(`json_type(x) = 'object'`) and every timestamp is JS-generated `YYYY-MM-DDTHH:MM:SS.sssZ`.

Run one CPU Modal job **per candidate** on separate Workflow paths, and couple them only at
atomic publication.

## 6. Traps that already cost time

- **Workflow instance IDs may not contain a colon.** They must match
  `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, ≤100 chars. The builder uses `${jobId}_${attempt}`.
  **D1 event keys are different** — `${jobId}:${attempt}:${status}` keeps its colons and is
  correct. Do not "fix" it.
- **`workflow.get(id).status()` throws for an absent instance**, it does not return unknown.
  `ABSENT_INSTANCE_MESSAGES` in `index.ts` catches exactly `instance.not_found` and
  `Engine was never started`, and nothing else.
- **`NonRetryableError` must carry the name AND a message that starts with it.** The name
  alone does not survive the RPC hop into miniflare's binding worker.
- **`assertWavHeader` assumes the canonical 44-byte layout** and reads `data` at offset 36.
  Real encoders emit `LIST`/`fact` chunks first. Not a live defect today (it only sees
  fake-mode bytes) but **Task 11 will feed it real provider audio** — replace it with
  `readWavProperties` from `src/audio/wav.ts`, which walks the chunk list and is
  mutation-proven against exactly that case.
- **A green integration suite proves nothing about a guard that only fires on state the happy
  path cannot produce.** Nine of twelve publication mutants survived the full suite for this
  reason. If you add a guard in Task 11, either extract it so a unit test can forge a
  violation, or add a contract check that proves it is still called. Section 15 in
  `scripts/twi-contract-check.mjs` is the worked example.
- **The mutants manifest's `baselines.currentAtHead.suites` block must stay compact,
  single-line per suite.** `scripts/lib/mutant-baselines.mjs` edits it with line-based
  regexes. Pretty-printing it silently breaks the updater — that has already happened once.
- **A new suite needs a human edit to the manifest.** `npm test -- --update-baselines` grows
  existing figures only; it refuses to add a suite it has never seen.

## 7. State of the code Task 11 touches

- `twi-orchestrator/src/workflow.ts` — steps: `load-job`, `generate-A`, `generate-B`,
  `persist-raw`, `finish`, `validate`, `publish`. `finish` is still the in-Worker fake path
  and is what Task 11 replaces with Modal.
- `twi-orchestrator/src/publication-guards.ts` — the extracted invariants. Reuse them.
- `twi-orchestrator/src/providers/select.ts` — `createProvider`, `mustNotRetry`,
  `canCompleteRender`.
- `stems-gpu/finish.py` — pure helpers, 17 gated tests. `app.py` has `finish_job` and
  `POST /finish/jobs`; `/status/{call_id}` returns `manifest` for finishing and the
  **unchanged** Stem Lab `stems` shape otherwise. That endpoint serves a live service.
- `docs/superpowers/mutants/harnesses/` — four runnable campaigns.

## 8. Still open, beyond Task 11

- `stems-gpu/test_registry.py` is ungated — pre-existing, deliberately not bundled into Task 10.
- The research's remaining P0: model the ambiguous paid call as
  `not_submitted → submitting → accepted/completed/ambiguous` with a persisted request ID and
  charge certainty. Task 9 delivered the `charged: boolean | null` semantics and
  `mustNotRetry`, but **not** the D1 state machine. Scoped out on purpose.
- Simon asked for a review of his other repositories for reusable patterns. Never done.
