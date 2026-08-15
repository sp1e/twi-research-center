# TWI Research Center — AI Music Creation and Production Studio

**Date:** 2026-08-16  
**Status:** Approved design  
**Target:** `https://sp1e.se/twi/`  
**Audience:** Single-owner, private professional studio for a musician/producer

## Summary

TWI Research Center is a private, desktop-first AI music creation and production studio integrated into the existing sp1e.se repository. It combines a guided full-song creation workflow with a non-destructive browser DAW, maximum-quality model routing, the existing Stem Lab separation system, personalized voice and instrument profiles, and complete project portability.

The product is not a visual or textual clone of Suno. Research into Suno identified the product patterns worth retaining: a low-friction path from an idea to a complete song, an advanced path for lyrics and granular style controls, audio upload and recording, iterative editing, stem export, and a browser-based production workspace. TWI reorganizes those ideas for a private professional workflow with stronger versioning, provenance, cost visibility, regional AI editing, crash recovery, and provider independence.

The product name remains an unexplained acronym. TWI has a standalone identity, without visible “by SP1E” branding inside the application, while inheriting the parent site's restraint and craft.

## Research basis

Public product research was conducted on 2026-08-15 and 2026-08-16.

- [Suno](https://suno.com/) demonstrates the strongest beginner-to-advanced creation funnel: a simple prompt, optional advanced controls, complete songs with vocals, remixing, audio upload, commercial-rights communication, sharing, and stems.
- [Suno Studio](https://suno.com/studio-welcome) demonstrates the professional expansion path: MIDI input, built-in instruments, effects, text-directed operations, multitrack editing, automation, advanced stem separation, and full/stem/range exports.
- [Google's music generation documentation](https://ai.google.dev/gemini-api/docs/music-generation) establishes an official full-song API candidate with custom-lyrics support. It is an initial adapter candidate, not a permanent dependency.
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) supports durable multi-step jobs, retries, and waiting for external events. [Cloudflare Queues](https://developers.cloudflare.com/queues/) supplies guaranteed-delivery buffering, delayed retries, and dead-letter handling.
- The existing repository already supplies Cloudflare Pages/Functions, D1, R2, owner authentication, Spotify integration, and a functional `/stems/` control plane backed by Modal GPU processing.

No official public Suno developer API was found during research. TWI must not depend on unofficial Suno endpoints or resellers that cannot demonstrate first-party authorization.

## Resolved decisions

| Branch | Decision |
|---|---|
| Product scope | Full creation and production platform, delivered as usable vertical slices |
| Primary audience | Musicians and producers |
| Access | Private; existing SP1E owner authentication; no public registration |
| Collaboration | Single owner; no multi-user roles or comments |
| Route | `/twi/` |
| Brand | TWI Research Center; unexplained acronym; standalone identity |
| Visual language | “Nocturne Instrument”: black, ivory, muted brass, mint audio-state signals |
| Default entry | Five-stage guided creation wizard |
| Expert entry | Skip wizard stages or open an empty studio directly |
| Model strategy | Provider-neutral hybrid using authorized official APIs and self-hosted audio tooling |
| Quality policy | Maximum quality on every render; no fast/cheap preview tier |
| Cost policy | No hard budget cap; estimate before submission and record actual cost |
| Rights policy | Broad creative freedom, verified consent for personal profiles, no deceptive impersonation |
| Device strategy | Desktop-first full studio; mobile creation, monitoring, playback, and downloads |
| Frontend | Isolated React + TypeScript application compiled into the existing site |
| Storage | R2/D1 authoritative with OPFS/IndexedDB local cache and recovery log |
| Stem Lab | Keep `/stems/` as a quick tool and share the same backend capabilities |
| Personalized generation | Generic performance controls plus private verified voice/instrument profiles |
| Interface language | English |

## Goals

1. Turn a detailed musical idea, lyrics, reference audio, or MIDI sketch into two complete maximum-quality song candidates.
2. Let the owner compare, branch, arrange, record, edit, mix, automate, regenerate, separate, master, and export without leaving the browser.
3. Make every AI and manual operation non-destructive, reversible, attributable, and recoverable.
4. Keep music providers replaceable through capability-based adapters and objective promotion gates.
5. Reuse Stem Lab's proven separation, R2 delivery, job history, and Modal GPU foundation.
6. Preserve source ownership and portability through complete exports and detailed provenance.

## Non-goals

- Public sign-up, subscriptions, credits, checkout, or a commercial SaaS launch.
- Public profiles, discovery feeds, likes, comments, follower graphs, or moderation queues.
- Real-time multi-user collaboration or workspace permissions.
- Unauthorized artist impersonation, deceptive voice cloning, or bypassing provider safety policies.
- Mobile parity with the desktop DAW.
- VST/AU binary plugin hosting in the browser. TWI provides built-in Web Audio/AudioWorklet effects and a documented internal effect interface instead.
- Dependence on private or reverse-engineered Suno APIs.

## Experience design

### Entry points

`/twi/` opens the private project library. The primary action is **New research session**. Secondary actions open a recent project, import an existing project bundle, or start with an empty studio.

`/stems/` remains a standalone quick utility. Completed Stem Lab jobs can be imported into a TWI project. TWI assets can open Stem Lab-compatible separation jobs without duplicating storage or processing logic.

### Guided creation protocol

The wizard uses progressive disclosure and supports back/forward navigation without losing state.

1. **Intent** — purpose, mood, narrative, duration, target medium, and instrumental/full-song choice.
2. **Composition** — custom lyrics, section structure, tempo, key, meter, arrangement notes, and instrumental roles.
3. **Sound** — genre vocabulary, references, uploaded audio/MIDI, inspiration strength, exclusions, novelty, and production character.
4. **Performance** — generic range/timbre/delivery controls or verified personal voice/instrument profiles.
5. **Commit** — frozen specification, rights assertion, selected capabilities/provider, expected duration, and estimated cost. Submission generates two candidates.

Experts can skip any optional stage, edit normalized parameters, or open an empty project. The UI uses musical language first and exposes provider-specific diagnostics only in an advanced inspector.

### Candidate review

Candidate review provides:

- Synchronized, loudness-matched playback and blind A/B mode.
- Waveforms, duration, sections, prompt notes, model/provider, seed, latency, estimated and actual cost.
- Actions to select, branch, regenerate, alter the frozen specification, separate stems, download, or open in the studio.
- Immutable retention of both candidates unless explicitly deleted.

Selecting a candidate creates a project revision that references the candidate asset. It does not copy or rewrite the audio.

### Studio workspace

The desktop layout has four stable regions:

- **Project rail:** assets, recordings, MIDI, profiles, versions, exports, and Stem Lab jobs.
- **Timeline:** tracks, regions, markers, tempo/key/meter map, automation lanes, and a playhead.
- **Transport/mixer:** playback, loop, count-in, metronome, recording, latency, meters, sends, buses, and master controls.
- **Inspector/co-producer:** parameters for the current selection and selection-aware AI commands.

Core operations include importing audio/MIDI, microphone recording, splitting/trimming/slipping/fading regions, routing, gain/pan, mute/solo, effects, automation, MIDI editing, and full/stem/selected-range export.

AI operations always target an explicit scope: a selected region, track, time range, group, or whole project. Operations include generate variation, replace region, extend arrangement, add layer, add harmony, rewrite lyrics, change performance, remix, and separate/clean stems. Each result is an immutable asset applied through a reversible project revision.

## Visual system

TWI's “Nocturne Instrument” direction uses:

- Near-black backgrounds with subtle depth, not generic flat charcoal panels.
- Warm ivory text and muted brass for hierarchy, selected versions, and committed actions.
- Mint only for live signal, playback, completed processing, active routing, and audio-safe success states.
- Restrained rose for destructive or failed states.
- Serif display type for editorial/research moments and a precise monospaced face for controls and metadata.
- Dense professional layouts on desktop, while preserving 44 px touch targets and visible keyboard focus where applicable.
- Motion that communicates transport, progress, selection, or hierarchy; reduced-motion mode removes decorative movement.

TWI uses its own wordmark and navigation. SP1E branding does not appear inside the product.

## System architecture

```text
Browser: TWI React application
  ├─ Wizard, library and studio UI
  ├─ Web Audio / AudioWorklet engine
  ├─ Web MIDI and MediaDevices recording
  └─ OPFS/IndexedDB cache + local recovery log
                 │ authenticated JSON/commands + signed asset transfers
                 ▼
Cloudflare Pages Function: /api/twi/*
  ├─ Existing owner-session verification
  ├─ Validation, authorization and cost estimation
  ├─ Project/revision/asset APIs
  └─ Starts or signals orchestration
                 │
                 ▼
TWI Orchestrator Worker
  ├─ Cloudflare Workflows for durable render pipelines
  ├─ Cloudflare Queues for rate limiting, retries and dead letters
  ├─ Provider adapters for music and personal profiles
  └─ Modal adapter for separation and finishing
        │                         │
        ▼                         ▼
 D1 metadata                R2 immutable media
 twi_* tables               twi/{project}/{asset}/...
```

### Deployment boundary

The existing Cloudflare Pages deployment remains the site origin. The compiled React application is emitted to `twi/`. Source code lives under `src/twi/` and has its own build/test configuration without changing existing pages to React.

TWI API routes live in `functions/api/twi/[[route]].ts`, following the nested route separation already used by Fredagsfett. Durable Workflows run in a small separately deployed Worker under `twi-orchestrator/`, invoked through a Cloudflare service binding. This avoids forcing Workflow lifecycle code into the Pages Function and keeps retries independent from user requests.

Modal remains a separately deployed GPU service. Provider and R2 credentials exist only as Cloudflare or Modal secrets.

### Large-file boundary

Workers coordinate media but do not proxy large completed files. The API issues short-lived, object-specific upload/download authorization. Providers and Modal write outputs directly to R2 through scoped credentials or signed URLs. Every completed upload is checksummed and registered before it becomes visible to a project.

## Module boundaries

### Browser modules

| Module | Responsibility | Depends on |
|---|---|---|
| `project-domain` | Project document, revisions, commands, undo/redo, validation | No UI or audio runtime |
| `audio-engine` | Web Audio graph, scheduling, transport, mixing, recording, offline render | Project-domain interfaces |
| `asset-cache` | OPFS/IndexedDB blobs, proxies, waveforms, eviction, recovery log | Asset API |
| `creation-wizard` | Draft specification, validation, estimate, submission | Capability catalog and job API |
| `candidate-review` | Synchronized A/B playback and branch actions | Audio engine and project API |
| `timeline` | Tracks, regions, selection, editing and automation UI | Project domain and audio engine |
| `midi` | Web MIDI, musical typing, piano roll and MIDI clips | Audio engine |
| `effects` | Built-in effects, AudioWorklet nodes, presets and automation schema | Audio engine |
| `co-producer` | Selection-scoped commands and result previews | Project/job APIs |
| `library` | Projects, assets, jobs, costs, profiles and exports | TWI API |

### Server modules

| Module | Responsibility |
|---|---|
| `auth` | Reuse and verify the existing owner session |
| `projects` | Project CRUD, revision commits, soft deletion and restore |
| `assets` | Signed transfers, checksums, manifests, provenance and permanent deletion |
| `jobs` | Job creation, state projection, cancel/retry and client polling |
| `capabilities` | Provider-neutral capability catalog and normalized constraints |
| `estimates` | Expected provider/GPU/storage cost and duration |
| `profiles` | Verified enrollment metadata and encrypted provider references |
| `exports` | Full song, stem, selected-range and portable project bundles |
| `orchestration` | Workflow/queue commands and callback verification |
| `observability` | Correlation IDs, structured events, quality metrics and cost ledger |

## Provider abstraction

The UI requests capabilities, not brand-specific endpoints. The music-provider contract declares support for capabilities such as:

- Full song with or without vocals.
- Custom lyrics and explicit section structure.
- Reference audio or MIDI conditioning.
- Deterministic seed where supported.
- Extend, remix, regional replacement, continuation, or inpainting.
- Generic performance controls.
- Personal profile enrollment and inference.

Adapters normalize requests and responses into TWI's generation specification and asset manifest. Unsupported combinations are rejected before cost confirmation. The first production adapter is chosen by the reference benchmark at implementation time; Google Lyria-class official access is the initial candidate. A provider is never promoted solely because it is newer or markets a higher version number.

## Maximum-quality render pipeline

1. Validate and freeze the normalized specification, reference assets, profile consent, rights assertion, capability requirements, and idempotency key.
2. Calculate and persist an estimate. The owner confirms the exact job before paid submission.
3. Start a durable Workflow and enqueue the provider submission.
4. Submit two candidates through the highest-ranked compatible authorized adapter.
5. Wait for callbacks or poll through a retry-safe provider step.
6. Ingest provider results directly into R2, checksum them, and create provisional asset rows.
7. Run the configured maximum-quality finishing chain on Modal: decode, optional separation, cleanup, loudness matching, mastering, waveform data, and editing proxies.
8. Validate non-silence, expected duration, decodability, clipping/true peak, channel layout, stem manifests, and output checksums.
9. Atomically expose both candidates, persist actual costs, and offer a revision commit.

Provider and GPU steps use idempotency keys. Retrying a Workflow step must not create a second paid generation or duplicate asset.

## Job lifecycle

```text
draft → estimated → queued → generating → ingesting → finishing → validating → complete
                              │              │             │
                              └──────────────┴─────────────┴→ error

queued | generating | ingesting | finishing → cancelling → cancelled
error → retrying → last safe state
```

`complete`, `error`, and `cancelled` are terminal. Cancellation is best-effort: a provider may finish after cancellation, in which case its artifact is retained as an unattached recoverable asset and its actual cost is recorded.

Each job stores a human-readable phase, machine-readable error code, retry checkpoint, provider/workflow IDs, estimate, actual cost, and an append-only event stream.

## Data model

D1 uses ordinary SQLite columns. Structured documents are serialized into validated TEXT fields or stored as immutable R2 JSON snapshots with a D1 key and checksum.

### `twi_projects`

Project identity, name, musical defaults, current revision ID, lifecycle state, and timestamps.

### `twi_project_revisions`

Immutable parent-linked revision records. Each row points to an R2 project-document snapshot and stores its checksum, summary, and creation time. Branching is represented through `parent_revision_id`; selecting a branch updates the project's current revision without deleting siblings.

### `twi_assets`

Immutable media metadata: project, kind, origin, R2 object keys, proxy/waveform keys, content type, size, duration, sample rate, channels, checksum, provenance document key, rights state, and deletion state.

Asset kinds include source, generation, recording, stem, MIDI, impulse response, proxy, master, and export.

Deleting an asset from the library is a soft hide while any retained revision, profile, job, or export references it. Permanent garbage collection is reachability-based: an R2 object can be destroyed only after every reference and retention window is gone. Permanently destroying a project removes objects exclusive to that project; shared profile/enrollment assets require their own explicit profile deletion.

### `twi_generation_specs`

Frozen normalized specifications with lyrics, arrangement, controls, exclusions, references, required capabilities, rights assertion, and checksum.

### `twi_jobs` and `twi_job_events`

Current job projection plus append-only transitions. Jobs record kind, project/revision/spec, provider/model, Workflow ID, provider job ID, status, phase, retry checkpoint, input/output manifest keys, estimate, actual cost, error, and timestamps.

### `twi_profiles`

Generic or personalized voice/instrument profiles. Personalized rows record verified enrollment time, consent statement version, encrypted external provider identifier, enrollment asset IDs, status, and deletion state. Raw enrollment audio remains private in R2.

### `twi_cost_events`

Append-only estimated or actual costs by job, provider, model, GPU seconds, storage, currency, quantity, and timestamp.

### `twi_exports`

Export scope and format, revision, R2 manifest, provenance sidecar, checksum, and timestamps.

## API surface

All owner routes require the existing same-origin owner session.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/twi/bootstrap` | Auth state, capability catalog and provider health summary |
| GET/POST | `/api/twi/projects` | List or create projects |
| GET/PATCH/DELETE | `/api/twi/projects/:id` | Read, rename or soft-delete a project |
| POST | `/api/twi/projects/:id/restore` | Restore within the retention window |
| GET/POST | `/api/twi/projects/:id/revisions` | List or commit immutable revisions |
| POST | `/api/twi/projects/:id/select-revision` | Move the current branch pointer |
| POST | `/api/twi/assets/uploads` | Create a scoped direct-upload authorization |
| POST | `/api/twi/assets/:id/complete` | Verify checksum and register an upload |
| GET/DELETE | `/api/twi/assets/:id` | Read metadata/URL or soft-hide an asset subject to reference retention |
| POST | `/api/twi/jobs/estimate` | Validate a specification and return time/cost estimate |
| GET/POST | `/api/twi/jobs` | List jobs or submit a confirmed job |
| GET | `/api/twi/jobs/:id` | Current state and event summary |
| POST | `/api/twi/jobs/:id/cancel` | Best-effort cancellation |
| POST | `/api/twi/jobs/:id/retry` | Resume from the recorded safe checkpoint |
| GET/POST | `/api/twi/profiles` | List or begin profile enrollment |
| GET/DELETE | `/api/twi/profiles/:id` | Inspect or permanently delete a profile |
| GET | `/api/twi/costs` | Cost ledger and provider breakdown |
| POST | `/api/twi/exports` | Start an export job |

Provider and Modal callbacks use separate shared-secret or signed-callback routes outside owner-cookie authorization. Every callback verifies signature, expected job/provider, replay window, and idempotency key.

## Local cache and recovery

- Project commands append immediately to a local operation log.
- A debounced autosave writes a project snapshot to R2 and commits a D1 revision pointer.
- Audio proxies, waveform data and recently used assets are cached in OPFS. IndexedDB stores indexes and small metadata.
- The durable cloud revision is authoritative. If a local recovery log is newer after a crash, the studio offers an explicit recovered branch rather than silently replacing the cloud version.
- A single-owner monotonic generation number prevents stale browser tabs from overwriting newer state.
- Cache eviction removes reproducible proxies first and never implies cloud deletion.

## Audio engine

The browser engine separates domain state from runtime nodes. The project document describes tracks, regions, routing, effects, automation and tempo. The runtime builds and schedules a Web Audio graph from that document.

Required engine capabilities:

- Sample-accurate transport scheduling and loop boundaries.
- Track/bus/master routing, gain, pan, mute, solo, sends and metering.
- Region trims, offsets, fades, crossfades, time placement and non-destructive gain.
- Microphone recording with device selection, monitoring safeguards and latency calibration.
- Web MIDI input, musical typing, piano-roll clips and tempo-aware scheduling.
- Built-in synths and effects through AudioWorklet where real-time work would block the main thread.
- Parameter automation with draw and record modes.
- Offline rendering for deterministic export where browser support permits it.
- Full mix, per-track/stem and selected-range exports in WAV and FLAC, with MP3 as a convenience derivative.

The implementation must establish a measured track-count and buffer-latency target on the actual supported browser before Pro Studio is accepted. Chrome/Edge desktop is the primary runtime; other browsers receive capability detection and explicit limitations.

## Rights, privacy and security

- TWI permits broad genre/style exploration but does not intentionally enable deceptive impersonation.
- Uploaded audio requires an owner rights assertion recorded with the frozen specification.
- Personalized voices and instruments require an explicit enrollment statement and private enrollment recordings.
- Provider rules remain enforced; TWI does not bypass model safety controls.
- Identifiable provider profile IDs are encrypted at rest with a Cloudflare secret and Web Crypto AES-GCM.
- R2 authorization is short-lived and limited to a single object or prefix.
- Upload validation checks extension, content type, magic bytes, size, duration and successful strict decode before processing.
- FFmpeg/model parsing runs in the isolated Modal service, never in the Worker request process.
- Cookie-authenticated mutations verify same-origin requests and anti-CSRF headers in addition to SameSite cookies.
- Secrets never enter client bundles, D1 plaintext fields, logs, project exports, or the repository.
- Project deletion is recoverable for 30 days. **Destroy now** requires typed confirmation and permanently removes R2 objects, metadata, enrollment records and external provider profiles where the provider supports deletion.

## Error handling

- Every failure exposes the failed phase, a readable explanation, a stable error code, whether money was charged, and available actions.
- Provider outages preserve the frozen specification and reference assets so the owner can retry or reroute without reconstructing work.
- Workflow retries resume from the last successful idempotent checkpoint.
- Lost callbacks are reconciled against provider or Modal job state before a job is marked stuck.
- A watchdog flags jobs whose phase-specific timeout is exceeded. It does not blindly resubmit paid generation.
- Finishing can degrade only when explicitly safe. For example, an ensemble may use surviving separation models and label the result; a missing required song candidate fails the job.
- Candidate publication is atomic: the review screen never exposes a half-registered pair.
- Browser decode, device, MIDI and microphone errors include recovery instructions and preserve unsaved project operations.

## Observability and cost

One correlation ID connects the browser command, Worker request, Workflow, queue messages, provider request, Modal call, asset keys and cost events.

Operational views report:

- Queue, provider, ingest, GPU finish and validation latency separately.
- Estimate versus actual cost per job, provider, model and processing stage.
- Retry counts, dead letters, callbacks, cancellations and stuck jobs.
- Provider error rate and capability health.
- Audio validation outcomes and human quality ratings by model.
- Browser underruns, decode failures, recording faults and export failures without collecting audio content.

Cost is never capped automatically. The exact estimate is shown before submission, actual cost is appended after each chargeable stage, and partial costs remain visible on failed or cancelled jobs.

## Testing and quality gates

### Automated correctness

- Unit tests for project commands/reducer, revision branching, audio graph construction, job state machine, idempotency, capability matching, estimates, rights validation and cache policy.
- Provider contract tests against recorded fixtures plus opt-in authenticated smoke tests.
- D1/R2/Workflow integration tests for complete, retry, callback loss, duplicate callback, cancellation, soft deletion and permanent deletion.
- Playwright journeys for wizard → estimate → two candidates → branch → studio edit → export, plus auth failure and crash recovery.

### Audio quality

- A versioned reference corpus spanning vocal genres, instrumentals, difficult mixes, transients, ambience, long tails and uploaded references.
- Automated checks for decodability, silence, duration, channel layout, DC offset, clipping, true peak, integrated loudness and malformed stems.
- Separation evaluation using suitable reference metrics where clean references exist, plus artifact-focused listening.
- Loudness-matched blind listening before changing the default generation, separation or mastering model.

### Studio performance

- Deterministic OfflineAudioContext golden renders for editing, automation and routing.
- Scheduling tests for loop boundaries, MIDI timing, tempo changes and automation precision.
- Stress tests for long sessions, waveform caches, repeated undo/redo, recording and export.
- Runtime telemetry for glitches/underruns and memory growth.

### Accessibility and resilience

- Complete keyboard operation for wizard, transport, selection, core edits and dialogs.
- Visible focus, semantic controls, reduced motion, contrast, text scaling and screen-reader labels.
- Offline/interrupted upload recovery, stale-tab protection and forced crash-recovery tests.

### Release rule

A phase is complete only when one real reference project passes its functional journey, audio-quality review, recovery test, accessibility check, security check, and cost/provenance audit. Interface completion alone is not acceptance.

## Delivery phases

### Phase 1 — Creation Core

Deliver the TWI app shell, owner auth, D1/R2 schema, durable orchestration, capability adapter, guided wizard, estimate confirmation, two maximum-quality candidates, A/B review, project library, provenance and cost ledger.

**Acceptance:** A real prompt and optional custom lyrics produce two playable, mastered candidates through the live site. Costs, model, provenance and failures are accurate.

### Phase 2 — Editor Core

Deliver the Web Audio transport and graph, imports, recording, timeline, regions, basic routing/mix, undo/redo, local cache, autosave/recovery, version branching, and shared Stem Lab integration.

**Acceptance:** A candidate can be separated, edited, recovered after a forced crash, reopened from the cloud, and exported without destructive source changes.

### Phase 3 — Pro Studio

Deliver MIDI input and musical typing, piano roll, built-in instruments, effects/sends, automation, advanced routing, full/stem/range exports, and measured performance limits.

**Acceptance:** The reference session runs stably at the documented track count and buffer setting, records MIDI/audio correctly, and produces deterministic exports.

### Phase 4 — AI Co-producer

Deliver selection-aware commands, regional replace/extend/remix, new layers, lyrics/harmonies, generic performance controls, and verified personal voice/instrument profiles.

**Acceptance:** Every AI edit is scoped, previewable, attributable, reversible, and covered by rights/provenance records.

### Phase 5 — Research Release

Deliver model-quality routing and promotion tooling, mobile companion behavior, keyboard workflow, accessibility completion, observability dashboards, full project bundle import/export, documentation and backup/restore verification.

**Acceptance:** A complete reference project passes every release rule and can be exported, deleted, restored within retention, permanently destroyed, and imported again without proprietary lock-in.

## Repository integration

The implementation adds focused directories rather than expanding existing large files:

```text
src/twi/                         React + TypeScript source
twi/                             generated static application assets
functions/api/twi/[[route]].ts   authenticated Pages Function API
twi-orchestrator/                Workflow + Queue Worker
stems-gpu/                       shared/extended Modal processing service
docs/twi/                        owner and deployment documentation
```

Existing routes remain unchanged. The current `/stems/` interface continues to work. Shared media-job primitives may be extracted behind stable interfaces, but unrelated Stem Lab UI behavior is not redesigned during Creation Core.

Schema changes use a new numbered `twi-migration-001-*.sql` sequence and the repository's idempotent migration runner. R2 objects use the `twi/` prefix so project deletion and lifecycle audits cannot affect existing hub, game, Fredagsfett or Stem Lab objects.

## Implementation prerequisites

The implementation can begin without additional product decisions. External actions required before live end-to-end generation are:

1. Provide credentials and approved access for at least one official full-song music-generation API.
2. Configure the TWI Orchestrator Worker, Workflow/Queue bindings and Pages service binding in Cloudflare.
3. Configure scoped R2 S3 credentials and any new Modal secrets used by finishing jobs.
4. Provide consented enrollment recordings only when Phase 4 personal profiles are implemented.

Provider selection remains a benchmark result, not an unresolved product decision. Phase 1 may use a deterministic fake adapter in local tests until live credentials are configured.

## Design acceptance

The design is internally consistent with these governing principles:

- Private single-owner product, not a public SaaS.
- Maximum-quality generation, with visible cost rather than a hard budget cap.
- Provider independence and authorized official access only.
- Non-destructive, immutable assets and revisions.
- Durable orchestration with explicit recovery boundaries.
- Professional desktop workflow with mobile companion behavior.
- Full portability, provenance, consent and permanent deletion.
- Vertical slices that each end in a real, tested, usable capability.
