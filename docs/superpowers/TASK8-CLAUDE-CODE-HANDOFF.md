# Claude Code handoff: TWI Task 8 Workflow Worker

> **SUPERSEDED IN PART, 2026-08-30.** Task 8's implementation is now GREEN and landed on
> `codex/twi-research-center-design` (merge `91832e8`, mirror `001491c`): the integration suite is
> 8/8, the nested suite 15/15, `npm test` is ALL SUITES PASSED (10/10), both root typechecks, the
> nested typecheck and `npm run build` pass, and the tree is clean afterwards. Sections 5 (measured
> failures) and 8 (remaining work items 1-4, 8-14) are therefore HISTORY, not instructions.
>
> Three claims in this document were measured and found WRONG. They are corrected here because a
> false claim about this repo's own safety net misdirects the next round:
>
> 1. **§2 and §6.1: the Workflow id `${jobId}:${attempt}` is IMPOSSIBLE.** Cloudflare validates an
>    instance id against `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, max 100 chars. A colon is rejected by
>    `create()`. The id is now `${jobId}_${attempt}`; the pair-identity requirement is unchanged.
>    See the SECOND AMENDMENT in the plan's Task 8.
> 2. **§6.1 point 2 and §9: a bare `npm test --prefix twi-orchestrator` does NOT silently skip on a
>    fresh clone.** Measured four ways: missing install exits 1; missing install while the repo root
>    HAS vitest also exits 1 (the root's binary does not leak onto the child's PATH); missing test
>    script exits 1; missing package.json exits 127. `scripts/run-tests.mjs` turns each into a suite
>    failure, so the naive wiring already failed closed. The wrapper that now exists guards the two
>    paths that ARE quiet, neither of which this document names: `--passWithNoTests` (exit 0 having
>    run nothing) and a nested package with no vitest config of its own, which runs under the
>    REPOSITORY ROOT's config and can report the root's counts as its own.
> 3. **§5.3 understated the root gate.** It was not merely unrun — it was RED, and had been since
>    `e33d259`. `.continue-here.md` was committed to the repository root without a `_redirects`
>    entry, so `scripts/landing-layout-check.mjs` correctly reported it PUBLICLY FETCHABLE. Fixed.
>
> Still genuinely outstanding from §8: items 15 (specification and code-quality reviews), 16 (the
> remaining mutation rounds) and 18 (the HANDOVER.md refresh). Item 17 is DONE.

Written for Claude Code on 2026-08-29 from a freshly measured WIP checkout. This document describes the branch as it exists, including failures. It is not a completion report and must not be treated as approval to merge.

## 1. Start here

Continue Task 8 of the TWI Creation Core plan on this branch:

- Repository: `https://github.com/simonpsson/sp1e.se.git`
- Branch: `codex/twi-task8-workflow`
- Remote tracking branch: `origin/codex/twi-task8-workflow`
- Implementation checkpoint: `e33d259` (`wip(twi): checkpoint Task 8 workflow implementation`)
- Task 8 base: `92d9c3a`
- Existing Windows worktree: `C:\Users\simon.pettersson\Documents\Codex\2026-08-15\new-chat\work\twi-verify\task8-codex`
- Canonical source checkout: `C:\Users\simon.pettersson\Documents\Codex\2026-08-15\new-chat\work\sp1e.se`

At the time this handoff was prepared, the branch was clean and `e33d259` existed on both the local and remote branch. This handoff itself is committed immediately after that checkpoint.

If the existing worktree is available, use it. Otherwise:

```powershell
git fetch origin
git switch --track origin/codex/twi-task8-workflow
npm ci
npm ci --prefix twi-orchestrator
```

Do not continue in a OneDrive clone or a similarly named checkout. The paths above identify the actual TWI repository and worktree.

## 2. Mission

Finish Task 8: create the internal Cloudflare Workflow Worker that accepts the existing job-dispatch envelope, generates two deterministic fake audio candidates, persists and validates all artifacts through the existing TWI repository state machine, and publishes both candidates atomically.

The implementation must exercise actual local Cloudflare Workflow, D1, and R2 behavior through the official test plugin. Do not replace those integration tests with hand-built mocks.

The complete specification is the `### Task 8` section in:

`docs/superpowers/plans/2026-08-16-twi-creation-core.md`

Read the amendment at the Step 5/6 boundary in full. Workflow identity is `${jobId}:${attempt}`, not only `jobId`. A retry is a new Workflow instance; a duplicate dispatch for the same job and attempt collapses to the existing instance.

## 3. Explicit user decisions

These decisions came directly from Simon and supersede any earlier suggestion to debate them:

1. Use Cloudflare's official plugin so tests exercise real Workflow, D1, and R2 semantics.
2. Reuse `TwiRepository` behind a small orchestrator adapter. Do not duplicate the job state machine or atomic publication invariants.
3. Fail closed for the Modal callback until it is genuinely configured.
4. Work autonomously. Do not stop to grill Simon about ordinary implementation choices.
5. Continue on the dedicated `codex/` branch. Do not modify `main`.

The current callback behavior is intentionally:

```text
POST /callback/modal -> 501
error.code = modal_callback_not_configured
```

Do not change that to a successful no-op, permissive acknowledgment, or simulated callback.

## 4. What has been implemented

The branch adds a new `twi-orchestrator/` sub-package with its own dependency graph:

- `@cloudflare/vitest-plugin` 1.1.2
- Vitest 4.1.11
- Wrangler 4.127.1
- Cloudflare Workers types 5.20260829.1
- TypeScript 7.0.2

The root repository deliberately uses older Cloudflare tooling, so do not flatten the nested package into the root dependency graph without a compelling, tested reason.

### Implemented and currently green

- `src/audio/wav.ts`: deterministic mono PCM WAV generation.
- `src/audio/wav.test.ts`: WAV metadata, frequency, length, and determinism coverage.
- `src/providers/types.ts`: provider contracts.
- `src/providers/fake.ts`: deterministic fake provider producing candidates A and B.
- `src/providers/fake.test.ts`: provider schema and byte determinism.
- Focused result measured 2026-08-29: 2 test files passed, 7 tests passed.

The exact command was:

```powershell
npm test --prefix twi-orchestrator -- src/audio/wav.test.ts src/providers/fake.test.ts
```

### Implemented but incomplete/unverified

- `src/index.ts`: `/start`, `/status/:id`, `/cancel/:jobId`, `/callback/modal`, error envelopes, queue fail-closed behavior.
- `src/db.ts`: `TwiWorkflowStore`, the small adapter around `TwiRepository` plus narrowly scoped D1 reads.
- `src/workflow.ts`: named Workflow steps for loading, generation, persistence, finishing, validation, and publication.
- `test/workflow.test.ts`: official-plugin integration tests using the real TWI migration, Workflow introspection, D1, and R2.
- `vitest.config.ts`, `wrangler.toml`, generated environment typing, and migration setup.

These files were started after observing the initial red test and were interrupted when Simon requested a checkpoint. They have not passed the integration suite or typecheck.

## 5. Exact measured failures at handoff

Do not assume the branch is green. The current red states are deliberate continuation points.

### 5.1 Workflow integration suite

Command:

```powershell
npm test --prefix twi-orchestrator -- test/workflow.test.ts
```

Measured result on 2026-08-29:

- 1 failed test file.
- 8 tests total.
- 2 passed.
- 6 failed.
- Exit code 1.
- All six failures first observe `/start` returning 500 instead of 202.
- The official runtime emits `Error: instance.not_found` from `WorkflowBinding.get` and secondary `Engine was never started` errors.

The likely first defect is in `src/index.ts`:

```ts
const statusOf = async (workflow, id) =>
  (await (await workflow.get(id)).status()).status;
```

The code assumes `workflow.get(id)` can represent an unknown instance and then yield status `unknown`. The official binding instead throws `instance.not_found` for an absent instance. That exception makes the initial `/start` path return the generic 500 response before `create()` runs.

Treat this as a hypothesis to confirm through the existing integration test. Preserve the test's official-plugin semantics; fix production behavior rather than mocking the exception away. Once `/start` reaches 202, let the next real failure determine the next TDD step.

The two tests currently passing are the malformed-attempt validation and the fail-closed route/method behavior. Re-run to confirm names and results after every material change.

### 5.2 Nested typecheck

Command:

```powershell
npm run typecheck --prefix twi-orchestrator
```

Measured result on 2026-08-29: exit code 1 with a large set of duplicate global declarations. The errors combine the root checkout's older `@cloudflare/workers-types/2023-07-01` declarations with the nested package's generated/current Worker declarations. Examples include duplicate `DOMException`, `WorkerGlobalScope`, `BufferSource`, `console`, WebAssembly types, and mismatched global event declarations.

The current `twi-orchestrator/tsconfig.json` explicitly loads:

```json
"types": [
  "@cloudflare/workers-types/2023-07-01",
  "@cloudflare/workers-types/experimental",
  "@cloudflare/vitest-plugin/types"
]
```

Resolve the type boundary cleanly. Do not use `skipLibCheck` as a blanket way to make the gate green unless the plan and a focused test prove that is the intended boundary. Prefer a single coherent Workers type source and ensure both production code and `cloudflare:test` compile.

### 5.3 Full root gates

The full root suite, root typechecks, build, bundle freshness, and mirror coverage have not been run on this WIP branch. Do not claim Task 8 complete until they are run after the nested package is green and root wiring is finished.

## 6. Current architecture and invariants

### HTTP/service entry point

`twi-orchestrator/src/index.ts` owns the internal Worker interface:

- `POST /start`
- `GET /status/:id`, where `id` is the exact Workflow instance ID including `:attempt`
- `POST /cancel/:jobId`, with the attempt in the strictly validated body
- `POST /callback/modal`, fail-closed until configured

The start envelope accepts exactly these keys:

```text
schemaVersion
jobId
projectId
specId
specSha256
idempotencyKey
attempt
estimate
```

The implementation currently exports `START_PAYLOAD_KEYS` to support the eventual cross-package contract check. Unknown keys, missing keys, invalid attempts, and malformed objects must fail before Workflow creation.

The Workflow instance ID function is `${jobId}:${attempt}`. Preserve this seam; it fixes a previously identified retry-collapse defect.

### Workflow

`twi-orchestrator/src/workflow.ts` currently defines these conceptual phases:

1. Load and freeze the queued job/spec through `TwiWorkflowStore`.
2. Transition queued -> generating.
3. Generate deterministic raw candidates A and B.
4. Store raw bytes in R2 and persist raw assets/provider costs.
5. Transition generating -> ingesting.
6. Produce master, preview, and provenance artifacts.
7. Persist all finished artifacts as provisional.
8. Transition ingesting -> validating.
9. Validate object existence, metadata, SHA-256, size, WAV shape, and provenance.
10. Use the repository publication transaction to publish A and B atomically and complete the job.

Failure-path invariants covered by the integration test include:

- Publication failure leaves every artifact provisional and the job in validating.
- Candidate B generation failure must not register or publish a partial generation.
- Validation failure leaves finished artifacts provisional.
- Same job/attempt collapses; a higher attempt creates a distinct instance.
- Cancel terminates only the requested job-attempt identity.

Do not weaken these expectations to accommodate the implementation.

### Repository adapter

`twi-orchestrator/src/db.ts` imports and uses the existing `TwiRepository` rather than recreating state and publication logic. Keep the adapter small. If an operation already exists in `TwiRepository`, call it. Direct D1 queries should only bridge orchestration-specific reads that the repository does not expose, and must preserve tenant/project/job/spec identity checks.

### Cloudflare configuration

`twi-orchestrator/wrangler.toml` intentionally configures:

- Worker name `twi-orchestrator`
- Main module `src/index.ts`
- Workflow binding `TWI_RENDER_WORKFLOW`
- D1 binding `DB`
- R2 binding `FILES`
- Queue producer binding `TWI_RENDER_QUEUE`
- Queue consumer with batch size 1
- `workers_dev = false`
- `preview_urls = false`

The Worker is internal-only. Do not accidentally expose a public workers.dev or preview URL while making tests pass.

## 7. Tests and TDD history

The lower-level modules were developed with observed red states:

- WAV test initially failed because `./wav` did not exist, then passed all 6 tests.
- Fake-provider test initially failed because `./fake` did not exist, then passed.
- Four 150-second fixtures initially caused a timeout; fixtures were reduced to schema-valid 30-second, 800 Hz samples without weakening metadata or byte-equality assertions.
- Workflow integration test initially failed because the Worker entry point did not exist. The production files were then started and the current official-runtime failures emerged.

Keep advancing one real failure at a time. Do not rewrite the integration tests into unit mocks.

There has also been a Workers/Vitest quirk in an earlier red run where a failure summary was printed despite an unexpected success process code. Always inspect the Vitest summary and make the eventual root runner fail closed when the nested suite is missing or reports failure.

## 8. Remaining Task 8 work

This list is ordered for the next implementation session.

1. Fix absent-instance handling in `/start` against the official Workflow binding.
2. Re-run only `test/workflow.test.ts`; follow the next observed failure.
3. Make all eight Workflow integration tests pass without weakening their state, R2, D1, identity, or fail-closed assertions.
4. Repair nested TypeScript configuration and make `npm run typecheck --prefix twi-orchestrator` pass.
5. Review `src/db.ts` against `TwiRepository` and remove any duplicated money-path/state-machine invariant.
6. Confirm every named Workflow step matches the plan and that retry configuration is intentional.
7. Confirm start/status/cancel responses and exact payload validation against the plan.
8. Add a cross-package contract check that pins `src/twi/server/jobs.ts`'s emitted `startPayload` keys to the orchestrator's accepted keys.
9. Wire `twi-orchestrator` into `scripts/run-tests.mjs` as the ninth root suite.
10. Make a missing nested `node_modules`/install fail that root suite explicitly. It must never silently skip on a fresh clone.
11. Add `twi-orchestrator/` and this committed handoff path to `scripts/twi-mirror-paths.txt` coverage as appropriate. The mirror coverage check must pass honestly.
12. Run the nested suite and nested typecheck from a clean install.
13. Run `npm test`, `npm run typecheck:twi`, `npm run typecheck:sp1epacker`, and `npm run build` from the root.
14. Confirm `git status --porcelain` is empty after the build; committed `/twi/` assets are production output.
15. Perform a Task 8 specification review, then a separate code-quality review. Important findings block closure.
16. Use mutation testing for critical contract/state/publication assertions. Verify every mutation actually applied and restore byte-identically.
17. Land on `codex/twi-research-center-design`, push the source branch, then run `npm run sync:twi-mirror`.
18. Refresh the main `docs/superpowers/HANDOVER.md` only after Task 8 is merged and all measured counts are current.

## 9. Required root integration

The root `npm test` currently runs eight named suites through `scripts/run-tests.mjs`. Task 8 must add a ninth orchestrator suite. The runner must:

- give the suite an explicit name;
- fail before attempting Vitest if `twi-orchestrator/node_modules` or required package entry points are absent;
- run the nested package in a way that propagates a real failure;
- never report `ALL SUITES PASSED` if the orchestrator suite was skipped;
- retain the existing sequential fail-fast reporting, where later suites are marked not run.

Add a guard or contract test that proves the missing-install failure is real. Do not rely on the current machine having the nested install.

The cross-package contract guard must compare independent sides of the seam: the exact object produced by `src/twi/server/jobs.ts` and the exact accepted keys in the orchestrator. A test that imports one shared constant into both sides can drift together and prove nothing.

## 10. Git and two-repository landing rules

The current WIP branch is safe to continue and is already backed up remotely. Do not rewrite or amend the checkpoint commit. Add new commits so review ranges remain true ancestor ranges.

The target source branch is `codex/twi-research-center-design`. `main` remains untouched.

After Task 8 is complete, reviewed, and green:

1. Merge the Task 8 branch into `codex/twi-research-center-design`.
2. Run the entire root gate and both typechecks.
3. Run the build and confirm a clean tree afterward.
4. Push `origin/codex/twi-research-center-design`.
5. From the canonical source repo, run `npm run sync:twi-mirror`.

The mirror repository is private and generated. Never hand-edit or hand-copy into:

`C:\Users\simon.pettersson\Documents\Codex\2026-08-15\new-chat\work\twi-research-center`

The mirror remote is `https://github.com/simonpsson/twi-research-center.git`, branch `main`. The sync script refuses unpublished source history and force pushes; let those guards work.

Do not mirror this WIP checkpoint now. The standing two-repository rule applies to landed, green changes after the source branch is merged and pushed.

## 11. Hard constraints and recurring traps

- Never modify `main`, `/stems/`, or non-TWI pages.
- Never invent or expand a meaning for the TWI acronym.
- Keep TWI UI copy in English; this Task 8 slice is backend-only.
- Never weaken a test, floor, baseline, or manifest to get green.
- Never overwrite source audio once real providers arrive in later tasks.
- Never use `npm ci --legacy-peer-deps`.
- Worktrees do not share `node_modules`; install root and nested dependencies in each new worktree.
- The repository uses LF. Avoid CRLF normalization.
- CI must not touch remote Cloudflare state.
- Migration 008 has never been run remotely; do not make an unrelated production migration attempt.
- Keep `workers_dev` and preview URLs disabled.
- Never run two mutation-capable agents in the same worktree.
- A mutation is only evidence if the edit was verified to have landed and the specific guard failed.
- Write long-running review reports incrementally because prior processes have been interrupted.

## 12. Read order for Claude Code

Read these before making a production edit:

1. This file.
2. `.continue-here.md`.
3. `docs/superpowers/plans/2026-08-16-twi-creation-core.md`, Task 8 in full.
4. `docs/superpowers/HANDOVER.md`, especially working agreement, mutation testing, traps, and limitations. Its task-status banner is stale; use this handoff for current Task 8 state.
5. `twi-orchestrator/test/workflow.test.ts`.
6. `twi-orchestrator/src/index.ts`.
7. `twi-orchestrator/src/workflow.ts`.
8. `twi-orchestrator/src/db.ts`.
9. `src/twi/server/repository.ts` and its interfaces/types.
10. `src/twi/server/jobs.ts`, especially the dispatched start payload.
11. `scripts/run-tests.mjs` and `scripts/twi-mirror-sync.mjs`.

On this machine, a deeper gitignored controller ledger may exist at:

`.superpowers/sdd/2026-08-16-twi-creation-core/progress.md`

It is useful historical context but not required to reproduce the branch. Do not assume it exists in another clone.

## 13. Suggested first Claude Code turn

Use this as the immediate execution brief:

> Continue Task 8 on `codex/twi-task8-workflow`. Preserve the official Cloudflare Vitest integration and the existing tests. First reproduce `npm test --prefix twi-orchestrator -- test/workflow.test.ts`. Confirm that absent-instance lookup in `/start` is the reason for the 500 response, then fix that behavior test-first against the real Workflow binding. Do not mock Workflow/D1/R2, do not weaken assertions, and keep `${jobId}:${attempt}` identity plus the fail-closed Modal callback. After each green boundary, proceed through the ordered remaining-work list in `docs/superpowers/TASK8-CLAUDE-CODE-HANDOFF.md`. Commit incremental, reviewable changes; do not amend `e33d259` and do not merge or mirror until every Task 8 gate is green.

## 14. Definition of done

Task 8 is done only when all of the following are true:

- All nested unit and Workflow integration tests pass using the official plugin.
- Nested typecheck passes without suppressing real declaration conflicts.
- The orchestrator reuses `TwiRepository` for state and atomic publication invariants.
- Same job/attempt is idempotent and a higher attempt is distinct.
- All success and failure-path state/R2/D1 invariants pass.
- Modal callback remains fail-closed unless a real configuration is added and tested.
- The ninth root suite exists and fails closed on missing nested dependencies.
- The cross-package start-envelope contract is independently pinned.
- Mirror path coverage includes the new TWI-owned paths.
- Full root tests, both root typechecks, and build pass.
- The tree is clean after build.
- Specification and code-quality reviews have no unresolved Critical or Important findings.
- Source target branch is pushed and the private mirror is synced through the script.
- The main handover is refreshed with newly measured counts.

Until every item above is true, describe the work as Task 8 WIP.
