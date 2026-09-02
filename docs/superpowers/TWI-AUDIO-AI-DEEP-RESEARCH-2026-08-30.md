# Claude Code handoff: TWI Audio-AI deep research

**Date:** 2026-08-30  
**Branch:** `codex/twi-research-deep-dive`  
**Base:** `origin/codex/twi-task8-workflow` at `454b90b`  
**Canonical evidence:** [`research/report-source.md`](research/report-source.md)  
**Purpose:** Amend the Creation Core implementation plan with current primary-source research. This does not claim Task 8 is complete.

## Executive decision

Keep Pages API + internal Cloudflare Workflow Worker + `TwiRepository` + D1/R2 + Modal. Keep real official-plugin Workflow/D1/R2 tests. Reuse `TwiRepository` and its atomic publication transaction. Keep `/callback/modal` fail-closed until authentication, replay protection and exact call identity exist.

Change four assumptions before production work:

1. **Workflow identity:** `${jobId}:${attempt}` violates Cloudflare's instance-ID grammar. Replace it with one shared, tested, allowed builder such as `${jobId}--${attempt}`.
2. **Duration:** Lyria Pro currently tops out around 184 s while TWI permits 240. Add capability-aware preflight/routing and refuse unsupported Lyria requests before charging.
3. **Mastering:** `-14 LUFS` belongs on a separate loudness-matched review rendition, not a destructively rewritten archival master.
4. **Providers:** Lyria is a cheap preview route, not the only foundation. Target Stability Audio for instrumental/SFX, Eleven Music for vocal/full-song/editing, Lyria behind a preview flag and MiniMax later as fallback. Quarantine Suno; Udio/Adobe lack verified public generation endpoints.

## Stop-the-line plan corrections

| Severity | Current assumption | Required amendment | Scope |
|---|---|---|---|
| P0 | Workflow ID `${jobId}:${attempt}`. | Shared `workflowInstanceId(jobId, attempt)` validates UUID/integer, outputs only allowed characters, stays under 100 chars; use in start/status/cancel/callback and seam tests. | Task 8, both packages, stale Task 8 handoff. |
| P0 | Up to 240 s is sent to Lyria. | Capability snapshot has min/max duration; estimate/submit fail `provider_capability_mismatch` or route elsewhere. Lyria max = 184 until official/live evidence changes. | Tasks 7/9/UI Commit. |
| P0 | “Maximum-quality” FLAC is two-pass normalized to -14 LUFS and Task 11 rejects other masters. | Split `raw`, `archive`, `review_preview`. Measure archive unchanged; apply controlled linear gain only to preview. | Tasks 10–11, schema, UI copy. |
| P0 | Retrying a generation step is harmless. | Model `not_submitted → submitting → accepted/completed` plus `ambiguous`; persist request ID and charge certainty. Never auto-retry ambiguous paid timeouts without provider idempotency/reconciliation. | Tasks 8–9/repository adapter. |
| P1 | Lyria has a fixed known sample rate. | Detect/persist actual format/rate/channels/duration; Google docs conflict at 44.1/48 kHz. | Task 9/provenance. |
| P1 | Ten images can always be inline. | Normalize thumbnails and cap aggregate provider bytes; originals and derivative hashes remain in R2. Probe Files support. | Task 9/uploads. |
| P1 | Workflow state is permanent history. | D1/R2 is source of truth; completed Workflow state is retained only 3/30 days. | Task 8/history. |
| P1 | One quality score promotes a model. | Separate technical, adherence, structure, diversity, originality, cost/latency and blind-human gates. | Evaluation roadmap. |

## Target provider contracts

Use a versioned capability registry instead of accumulating booleans:

```ts
type MusicCapability =
  | 'instrumental' | 'full_song' | 'lyrics' | 'image_conditioning'
  | 'reference_audio' | 'region_edit' | 'stems' | 'realtime' | 'video_score';

interface ProviderModelCapability {
  provider: string;
  model: string;
  status: 'production' | 'preview' | 'experimental' | 'quarantined';
  capabilities: readonly MusicCapability[];
  minDurationSeconds: number;
  maxDurationSeconds: number;
  acceptedInputs: readonly string[];
  possibleOutputs: readonly string[];
  commercialModeAllowed: boolean;
  trainingPosture: 'licensed_claimed' | 'disclosed_mixed' | 'undisclosed' | 'noncommercial';
  watermark: 'synthid' | 'c2pa_optional' | 'provider_specific' | 'none_known';
  pricingPolicyVersion: string;
  termsSnapshot: string;
}
```

Persist the selected capability snapshot with every job. Provider result must record actual—not requested—duration, format, bytes, SHA-256, decoded-PCM hash where available, sample rate, channels, bit depth, request ID, cost, `charged: boolean | null`, watermark and returned lyrics/structure.

Use stable public error codes: `provider_rejected`, `provider_rate_limited`, `provider_auth_failed`, `provider_capability_mismatch`, `provider_invalid_audio`, `provider_unavailable`, `provider_result_ambiguous`. Retryability and charge certainty are separate fields. Never log prompts, keys or raw provider bodies.

## Asset classes

```text
provider raw (immutable, bit-for-bit)
  ├─ archive lossless (optional controlled conversion; no loudness target)
  └─ review preview (MP3; loudness matched for unbiased A/B)
       └─ later user-selected export master(s)
```

Every edge is a provenance action with input/output hashes, tool/container version and command-array digest. Replace ambiguous `masterUrl` semantics with explicit archive/review/export names before users depend on it.

## Task amendments

### Task 8 — Workflow

- Fix the colon identity first and update the existing handoff instruction that explicitly preserves it.
- Keep generation + R2 persistence inside the same `step.do`; return only small manifests because step/event payloads max at 1 MiB.
- Keep named phases if implemented, but external paid calls are not exactly-once simply because Workflow is durable.
- Publish through `TwiRepository`; both candidates remain provisional until every check passes.
- Official-plugin tests: legal instance ID; duplicate same attempt; higher attempt; event-before-wait; duplicate/forged callback; R2 head/checksum mismatch; one-candidate failure; ambiguous provider call cannot duplicate.
- D1/R2 powers durable history, not Workflow retention.

### Task 9 — Lyria preview adapter

- Keep official Interactions endpoint/model and WAV request.
- Preflight 184 s and aggregate image bytes; never silently shorten.
- Parse every output step, preserve lyrics/structure, reject missing/malformed/ambiguous audio.
- Probe RIFF/WAVE then strict-decode/ffprobe downstream; store observed media properties.
- Map 429, safety, auth, invalid audio and ambiguous timeout separately. Back off only safe retryable failures.
- Store price policy/version and actual charge. Current two-candidate baseline is $0.16, not an eternal code constant.
- Add a secret-gated manual live canary for sample rate, duration, structure, marking and charge/retention behavior; never run it in default CI.
- Keep production fail-closed if no eligible provider is configured.

### Tasks 10–11 — Modal finishing

- Rename “maximum-quality mastering” to validation and review rendering.
- Keep immutable raw; archive is unchanged or losslessly converted without loudness target; review MP3 is loudness matched.
- Two-pass `loudnorm` may create review audio, but require linear mode and explicit output rate. Record first pass, second-pass parameters, FFmpeg version and command digest.
- Archive validation: strict decode, duration tolerance, finite samples, channels/rate, bytes/hash, silence, DC offset, clipping, dBTP and measured LUFS/LRA. No `-14` archive gate.
- Preview validation: MP3, duration, justified `-14 LUFS` tolerance, max `-1 dBTP`, no clipping, correct ingredient hash.
- Use one CPU Modal job per candidate on separate Workflow paths; couple only at atomic publication. FFmpeg needs no GPU.
- Callback binds job, attempt, candidate, asset prefix and Modal call ID; validate proxy/application auth, timestamp, nonce and unique callback ID before `sendEvent`.

### Task 14 — blind A/B

- Play preview MP3, not archival WAV/FLAC.
- Route two media elements through one AudioContext with separate GainNodes; schedule/crossfade on one clock; retain drift correction and test long media on major browsers.
- Loudness-match candidates. Hide provider/model/cost until blind vote is committed.
- Private, short-lived, range-capable media URLs; never public R2 bucket.
- Keyboard/focus/labelled state/screen-reader status; not color-only selection.

## Provider rollout

1. Finish Task 8 using fake provider and corrected identity/idempotency.
2. Implement Lyria as scoped but mark it preview/capability-limited.
3. Add registry and Stability adapter for instrumental/SFX/long duration.
4. Add Eleven only after exact-tier terms review, for vocals/composition/editing/stems.
5. Evaluate MiniMax as data-policy-explicit fallback; Mureka only controlled R&D.
6. Quarantine Suno until public contracts and acceptable terms/provenance exist. Never use unofficial APIs. No Udio/Adobe adapters without public endpoints.
7. Self-host only commercially permitted weights/data postures. Managed hosting does not cure a non-commercial licence.

## Evaluation programme

Every run manifest stores prompt/spec/control hashes; provider/model/revision; seed/RNG where supported; generation parameters; requested/actual media; code/container/hardware/tool versions; transforms; costs/latency/errors; terms and capability snapshot.

| Gate | Initial scope | Purpose |
|---|---|---|
| PR smoke | Small fixed fake/local set | Decode/header/duration/rate/channels/finite/non-silent, deterministic fake, manifest/state invariants. No FAD claim. |
| Nightly | ~60 prompt families × 4 samples/model | Paired baseline, p50/p95 latency/cost/failure, health, adherence slices, diversity, worst decile; bootstrap by prompt. |
| Release | Private holdout, ideally ≥150 prompts × 8 samples if budget permits | Swedish/English/OOD/adversarial/long-form; stratified blind humans; originality; frozen evaluator versions. Never tune on it. |

Never collapse these into one score:

- hard validity: decode, duration/rate/channels, NaN/Inf, silence, clipping, DC/discontinuities;
- production diagnostics: LUFS/LRA/dBTP, crest, stereo/phase, spectrum and seams;
- adherence: vocal/instrumental, lyrics/language, BPM/key/meter, instruments/mood/sections;
- long form: worst windows, motif return, drift, loop collapse, transitions, ending;
- diversity: same-prompt distance, duplicates and coverage without losing adherence;
- originality: fingerprints, chroma/cover matching, embeddings and local-window search; flags go to human/legal review;
- product: blind preference, latency, cost, availability and safety rejection.

FAD is only fixed equal-N set-level diagnostics with pinned embeddings/reference. CLAP/MuLan are semantic diagnostics. Neither ships a model. Use randomized loudness-matched pairwise A/B for open songs; use real MUSHRA only when reference and anchor exist (codec/separation/editing).

Stem Lab: keep Demucs pinned as legacy while benchmarking BS-RoFormer-class systems on MUSDB18HQ plus private hard cases. Evaluate SI-SDRi and scale-dependent SDR, reconstruction, leakage, silent targets, runtime/VRAM and listening—not headline SDR alone.

## Provenance, rights and privacy

Ship a signed canonical JSON sidecar now; embedded C2PA follows interoperability testing. C2PA is provenance, not truth/ownership. Preserve SynthID/provider credentials and the original file.

Replace one `rightsAccepted` flag with versioned records for uploaded-audio/lyrics/melody/image rights; identifiable voice/likeness consent, scope/expiry/revocation; provider commercial tier and terms; provider retention/training posture; AI marking; human contribution; similarity review; territory/use restrictions and counsel decisions.

EU Article 50 marking is applicable since 2 August 2026. Preserve machine-readable marks and visibly disclose deepfake/identifiable synthetic likeness publication where required. Voice/reference uploads can be personal data: minimize, restrict, set retention/deletion, record processor/region/transfers and support consent withdrawal. Publicly reachable music is not automatically trainable; TDM reservations and copyright/licences matter.

Preserve human authorship evidence: user-written lyrics/melody, selections, edits, arrangement, comping, automation and export decisions. Provider-assigned output rights do not warrant copyright, non-infringement or performer clearance.

## P0 / P1 / P2 backlog

### P0 — before paid production generation

- Legal Workflow ID everywhere with cross-package tests.
- Capability preflight: Lyria 184 s and image-byte budget.
- Ambiguous-paid-call state; no blind retries.
- Raw/archive/review split; amend loudness assertions.
- Immutable provenance sidecar and actual-media probing.
- Authenticated/replay-safe Modal callback bound to call/job/attempt/candidate.
- Preserve AI marks and add rights/voice-consent gates.

### P1 — before provider promotion/public use

- Versioned registry, pricing/terms snapshots, health probes and kill switches.
- Live canary outside CI; golden nightly/release harness/dashboard.
- Stability/Eleven adapters after exact terms review; retention controls.
- Private signed range media and AudioContext A/B.
- Cost ledger: provider, Workflow, Modal CPU, R2 and uncertain charges.
- Model change detection; paired evaluation required for promotion.

### P2 — expansion

- MiniMax/Mureka pilots, ACE-Step research, modern separator bake-off.
- Embedded C2PA after tests; BWF/advanced export profiles.
- Optional 30 s audition and Lyria RealTime experiments, never silent substitutes for two full songs.
- Memorization search against rights-cleared catalogues and expert listening operations.

## Acceptance criteria

- No production Workflow ID contains `:`.
- A 185–240 s Lyria selection fails/reroutes before its call.
- No archival/master asset must be -14 LUFS.
- Review derives traceably from immutable original with measurements/hashes.
- Ambiguous paid calls cannot be blindly repeated.
- Provider/model/capability/pricing/terms/marking survives into D1/R2 provenance.
- Publication remains atomic through `TwiRepository`.
- Callback and media stay private/fail closed.
- No model promotes on FAD, CLAP or one MOS alone.
- Tests retain official-plugin Workflow/D1/R2 semantics.

## Mandatory live/counsel checks

- Probe Lyria WAV rate, duration adherence, block shape, retention and charge behavior on TWI's paid project.
- Verify Eleven's purchased-tier features/terms.
- Verify each provider's idempotency/reconciliation after ambiguous failures.
- Test C2PA preservation through selected audio/browser/distribution chain.
- Obtain Swedish/EU counsel before public launch, voice cloning, third-party training/fine-tuning or reliance on TDM.
- Calibrate every automated threshold against TWI expert/target-user judgment.

## Continuation prompt for Claude Code

> Read `docs/superpowers/TWI-AUDIO-AI-DEEP-RESEARCH-2026-08-30.md` and `docs/superpowers/research/report-source.md`. First amend Task 8 test-first so the shared Workflow ID builder uses Cloudflare's legal character set instead of `${jobId}:${attempt}`, without weakening official-plugin Workflow/D1/R2 tests or bypassing `TwiRepository`. Then amend the plan for capability-aware Lyria duration preflight, ambiguous paid-call semantics and raw/archive/review separation. Preserve the fail-closed Modal callback until authenticated. Reconcile with the active Task 8 worktree; do not merge the research branch blindly.

