# TWI Research Center Creation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first usable TWI Research Center release at `/twi/`: owner-authenticated projects, a five-stage creation wizard, explicit cost confirmation, two maximum-quality full-song candidates, loudness-matched A/B playback, provenance, and a durable job/cost history.

**Architecture:** An isolated React + TypeScript application compiles to the existing Cloudflare Pages site. A nested Pages Function owns `/api/twi/*`, D1 metadata, R2 assets, and owner-session checks; it invokes a separate Cloudflare Workflow Worker through a service binding. The Workflow uses a capability-based provider adapter (deterministic fake locally, official Lyria 3 Pro in production), writes immutable audio to R2, invokes a Modal finishing job, and publishes both candidates atomically.

**Tech Stack:** React 19, TypeScript, Vite, Zustand, Zod 3, Vitest, Testing Library, Playwright, Cloudflare Pages Functions, D1, R2, Cloudflare Workflows/Queues, Modal/FastAPI/FFmpeg, and the Google Gemini Interactions API (Lyria 3 Pro).

**Design specification:** `docs/superpowers/specs/2026-08-16-twi-research-center-design.md`

---

## Scope and phase boundary

This plan implements **Phase 1 — Creation Core only**. It establishes interfaces that later plans will extend, but it does not implement the multitrack engine, recording, MIDI, effects, personal-profile enrollment, regional AI editing, mobile companion, or public collaboration.

Phase 1 accepts text, custom lyrics, musical controls, and up to ten image references because those capabilities are supported by the initial official adapter. Audio and MIDI references appear in the capability catalog as unavailable until a compatible authorized provider is added; the wizard explains the limitation instead of silently dropping inputs.

## File map

### New frontend files

```text
src/twi/index.html                     Vite HTML entry
src/twi/main.tsx                       React bootstrap
src/twi/app/App.tsx                    Route/state composition and auth gate
src/twi/app/app.css                    Nocturne Instrument tokens and shared layout
src/twi/app/App.test.tsx               Shell/auth tests
src/twi/domain/types.ts                Shared project, spec, job, asset and provider types
src/twi/domain/schemas.ts              Zod request/response validation
src/twi/domain/prompt.ts               Deterministic Lyria prompt compiler
src/twi/domain/prompt.test.ts          Prompt/compiler tests
src/twi/domain/job-state.ts            Legal job transitions and terminal-state helpers
src/twi/domain/job-state.test.ts       State-machine tests
src/twi/api/client.ts                  Typed `/api/twi` client
src/twi/api/client.test.ts             Fetch/error contract tests
src/twi/store/useTwiStore.ts           Project, draft, job and candidate state
src/twi/features/library/Library.tsx   Project list and create/open actions
src/twi/features/library/Library.test.tsx
src/twi/features/wizard/Wizard.tsx     Five-stage coordinator
src/twi/features/wizard/steps/*.tsx    One focused component per wizard stage
src/twi/features/wizard/Wizard.test.tsx
src/twi/features/candidates/CandidateReview.tsx
src/twi/features/candidates/CandidateReview.test.tsx
src/twi/features/candidates/SyncedPlayer.tsx
src/twi/features/candidates/SyncedPlayer.test.tsx
src/twi/features/jobs/JobProgress.tsx  Explicit phase, estimate, actual cost and retry UI
src/twi/features/jobs/JobProgress.test.tsx
src/twi/test/setup.ts                  DOM/media test shims
```

### New server and orchestration files

```text
functions/api/twi/[[route]].ts         Pages Function entry and route table
src/twi/server/http.ts                 JSON, errors, origin checks and cookie helpers
src/twi/server/auth.ts                 Existing `session` cookie verification
src/twi/server/repository.ts           Repository interface and D1 implementation
src/twi/server/projects.ts             Project/revision use cases
src/twi/server/assets.ts               Image upload and R2 asset registration
src/twi/server/jobs.ts                 Estimate, submit, list, cancel and retry use cases
src/twi/server/capabilities.ts         Provider-neutral public capability catalog
twi-orchestrator/wrangler.toml         Worker, Workflow, D1/R2 and queue bindings
twi-orchestrator/src/index.ts          Internal service endpoints and Workflow export
twi-orchestrator/src/workflow.ts       Durable two-candidate render pipeline
twi-orchestrator/src/providers/types.ts
twi-orchestrator/src/providers/fake.ts
twi-orchestrator/src/providers/lyria.ts
twi-orchestrator/src/providers/lyria.test.ts
twi-orchestrator/src/audio/wav.ts      Deterministic fake WAV generator
twi-orchestrator/src/audio/wav.test.ts
twi-orchestrator/src/db.ts             Guarded job/event/asset writes
twi-orchestrator/test/workflow.test.ts
```

### New database, GPU, tests and documentation

```text
twi-migration-001-creation-core.sql
scripts/twi-schema-behavior.test.mjs
scripts/twi-contract-check.mjs
scripts/twi-e2e-api.mjs
playwright.twi.config.ts
test/twi/creation-core.spec.ts
stems-gpu/finish.py
stems-gpu/test_finish.py
docs/twi/creation-core-runbook.md
```

### Modified files

```text
package.json                         Add TWI build/test commands and dependencies
package-lock.json                    Lock dependency graph
vitest.config.ts                     Include TWI jsdom tests while preserving current tests
scripts/apply-migrations.mjs         Recognize the `twi-migration-` series
_redirects                           Route `/twi`, block TWI sources/config/migrations
_headers                             Permit same-origin microphone and TWI/R2 connections
wrangler.toml                        Add TWI orchestrator service binding declaration/comments
stems-gpu/app.py                     Add finishing job and generic status result
stems-gpu/README.md                  Document TWI finishing deployment and secrets
PROJECT.md                           Register TWI route, stack, commands and schema
```

---

### Task 1: Establish the isolated React/Vite application

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Create: `vite.twi.config.ts`
- Create: `tsconfig.twi.json`
- Create: `src/twi/index.html`
- Create: `src/twi/main.tsx`
- Create: `src/twi/app/App.tsx`
- Create: `src/twi/app/App.test.tsx`
- Create: `src/twi/app/app.css`
- Create: `src/twi/test/setup.ts`

- [ ] **Step 1: Install the isolated app dependencies**

Run:

```powershell
npm install react@19.2.8 react-dom@19.2.8 zustand@5.0.15
npm install --save-dev vite@8.2.1 @vitejs/plugin-react@6.0.5 @types/react@19.2.18 @types/react-dom@19.2.4 @testing-library/react@16.3.2 @testing-library/user-event@14.6.4
```

Expected: `package.json` and `package-lock.json` change; `npm ls react vite` exits 0.

- [ ] **Step 2: Add exact scripts without changing existing commands**

Add to `package.json`:

```json
{
  "scripts": {
    "build:twi": "vite build --config vite.twi.config.ts",
    "test:twi": "vitest run --config vite.twi.config.ts",
    "typecheck:twi": "tsc --noEmit -p tsconfig.twi.json"
  }
}
```

Change the existing `build` script to:

```json
"build": "npm run build:sp1epacker && npm run build:twi"
```

Do not change `test:sp1epacker` or any existing dependency version.

- [ ] **Step 3: Configure Vite to emit only into `/twi/`**

Create `vite.twi.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/twi',
  base: '/twi/',
  plugins: [react()],
  build: {
    outDir: '../../twi',
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/twi/test/setup.ts'],
    include: ['src/twi/**/*.test.{ts,tsx}'],
  },
});
```

Create `tsconfig.twi.json`:

```json
{
  "extends": "./tsconfig.sp1epacker.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals"]
  },
  "include": ["src/twi/**/*.ts", "src/twi/**/*.tsx", "vite.twi.config.ts"]
}
```

- [ ] **Step 4: Write the failing shell/auth test**

Create `src/twi/app/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App';

test('shows the TWI identity while owner auth is checked', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<App />);
  expect(screen.getByRole('heading', { name: 'TWI Research Center' })).toBeInTheDocument();
  expect(screen.getByText('Verifying private access…')).toBeInTheDocument();
});
```

Create `src/twi/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Install the matcher package:

```powershell
npm install --save-dev @testing-library/jest-dom@7.0.1
```

- [ ] **Step 5: Run the test and verify the red state**

Run:

```powershell
npm run test:twi -- src/twi/app/App.test.tsx
```

Expected: FAIL because `./App` does not exist.

- [ ] **Step 6: Implement the minimal app shell**

Create `src/twi/index.html` with `<div id="root"></div>` and a module script for `/main.tsx`. Create `src/twi/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
```

Create `src/twi/app/App.tsx`:

```tsx
import { useEffect, useState } from 'react';

type AuthState = 'checking' | 'allowed' | 'denied';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  useEffect(() => {
    fetch('/api/auth/check', { credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : { authenticated: false })
      .then((body: { authenticated?: boolean }) => setAuth(body.authenticated ? 'allowed' : 'denied'))
      .catch(() => setAuth('denied'));
  }, []);
  return (
    <main className="twi-shell">
      <header className="twi-header"><span className="twi-mark">TWI</span></header>
      <section className="twi-entry">
        <p className="twi-kicker">Private audio research environment</p>
        <h1>TWI Research Center</h1>
        {auth === 'checking' && <p>Verifying private access…</p>}
        {auth === 'denied' && <a href="/">Return to SP1E to authenticate</a>}
        {auth === 'allowed' && <p>Creation Core ready.</p>}
      </section>
    </main>
  );
}
```

Define the approved Nocturne tokens in `src/twi/app/app.css`:

```css
:root {
  --twi-bg: #08090c;
  --twi-panel: #0e1014;
  --twi-ivory: #f3efe6;
  --twi-muted: rgba(243,239,230,.56);
  --twi-brass: #cbab63;
  --twi-signal: #4af2c8;
  --twi-danger: #ed8d97;
  --twi-line: rgba(243,239,230,.12);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--twi-bg); color: var(--twi-ivory); font-family: "DM Mono", ui-monospace, monospace; }
button, input, textarea, select { font: inherit; }
:focus-visible { outline: 2px solid var(--twi-signal); outline-offset: 3px; }
.twi-shell { min-height: 100vh; }
.twi-header { padding: 18px 24px; border-bottom: 1px solid var(--twi-line); }
.twi-mark { color: var(--twi-brass); font-weight: 700; letter-spacing: .18em; }
.twi-entry { max-width: 900px; margin: 0 auto; padding: 12vh 24px; }
.twi-kicker { color: var(--twi-brass); text-transform: uppercase; letter-spacing: .14em; }
```

- [ ] **Step 7: Verify test, typecheck and build**

Run:

```powershell
npm run test:twi -- src/twi/app/App.test.tsx
npm run typecheck:twi
npm run build:twi
```

Expected: all exit 0; `twi/index.html` and hashed assets exist; no file outside `twi/` is generated.

- [ ] **Step 8: Commit the isolated shell**

```powershell
git add package.json package-lock.json vite.twi.config.ts tsconfig.twi.json src/twi twi
git commit -m "feat(twi): add isolated React application shell"
```

---

### Task 2: Define the normalized creation specification and prompt compiler

**Files:**
- Create: `src/twi/domain/types.ts`
- Create: `src/twi/domain/schemas.ts`
- Create: `src/twi/domain/prompt.ts`
- Create: `src/twi/domain/prompt.test.ts`

- [ ] **Step 1: Write failing normalization and prompt tests**

Create `src/twi/domain/prompt.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { compileLyriaPrompt, normalizeGenerationSpec } from './prompt';

const draft = {
  intent: { purpose: 'album track', mood: ['intimate', 'unstable'], narrative: 'leaving home', durationSeconds: 150, instrumental: false },
  composition: { lyrics: '[Verse]\nNorthbound again', sections: ['Intro', 'Verse', 'Chorus'], bpm: 82, key: 'F minor', meter: '7/8', arrangement: 'bowed bass and dry drums' },
  sound: { styles: ['art rock', 'trip-hop'], exclusions: ['festival EDM'], novelty: 72, imageAssetIds: [] },
  performance: { mode: 'generic' as const, vocalRange: 'low', timbre: 'close and grainy', delivery: 'restrained' },
  rightsAccepted: true,
};

test('normalization trims and deduplicates controls', () => {
  const normalized = normalizeGenerationSpec({
    ...draft,
    sound: { ...draft.sound, styles: [' art rock ', 'art rock'] },
  });
  expect(normalized.sound.styles).toEqual(['art rock']);
  expect(normalized.sound.novelty).toBe(72);
});

test('schema rejects novelty outside the supported range', () => {
  expect(() => normalizeGenerationSpec({
    ...draft,
    sound: { ...draft.sound, novelty: 130 },
  })).toThrow();
});

test('Lyria prompt contains timing, musical controls, lyrics and exclusions', () => {
  const prompt = compileLyriaPrompt(normalizeGenerationSpec(draft));
  expect(prompt).toContain('Target duration: 2 minutes 30 seconds');
  expect(prompt).toContain('Tempo: 82 BPM');
  expect(prompt).toContain('Key: F minor');
  expect(prompt).toContain('Meter: 7/8');
  expect(prompt).toContain('[Verse]\nNorthbound again');
  expect(prompt).toContain('Avoid: festival EDM');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run `npm run test:twi -- src/twi/domain/prompt.test.ts`.

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Define shared types and Zod schemas**

Create `src/twi/domain/types.ts` with these exported contracts:

```ts
export type JobStatus = 'draft' | 'estimated' | 'queued' | 'generating' | 'ingesting' | 'finishing' | 'validating' | 'complete' | 'cancelling' | 'cancelled' | 'error' | 'retrying';
export type JobPhase = Exclude<JobStatus, 'draft' | 'estimated'>;
export type AssetKind = 'image-reference' | 'generation-raw' | 'generation-master' | 'generation-preview' | 'provenance';

export interface GenerationSpec {
  intent: { purpose: string; mood: string[]; narrative: string; durationSeconds: number; instrumental: boolean };
  composition: { lyrics: string; sections: string[]; bpm: number | null; key: string; meter: string; arrangement: string };
  sound: { styles: string[]; exclusions: string[]; novelty: number; imageAssetIds: string[] };
  performance: { mode: 'generic'; vocalRange: string; timbre: string; delivery: string };
  rightsAccepted: true;
}

export interface CapabilityCatalog {
  provider: string;
  fullSong: boolean;
  customLyrics: boolean;
  imageReference: boolean;
  audioReference: boolean;
  midiReference: boolean;
  deterministicSeed: boolean;
  maxImageReferences: number;
  outputFormats: Array<'audio/wav' | 'audio/mpeg'>;
}

export interface CostEstimate { currency: 'USD'; provider: number; finishing: number; storage: number; total: number; estimatedSeconds: number; }
export interface CandidateAsset { id: string; label: 'A' | 'B'; previewUrl: string; masterUrl: string; durationSeconds: number; provider: string; model: string; actualCost: number; }
```

Create `src/twi/domain/schemas.ts` using the repository's existing Zod 3 dependency. Export `generationSpecSchema`, `estimateRequestSchema`, and `submitJobSchema`. Enforce duration 30–240 seconds, BPM 30–300, novelty 0–100, at most 10 image IDs, non-empty purpose/styles, and `rightsAccepted: z.literal(true)`.

- [ ] **Step 4: Implement deterministic normalization and compilation**

Create `src/twi/domain/prompt.ts`:

```ts
import { generationSpecSchema } from './schemas';
import type { GenerationSpec } from './types';

const cleanList = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

export function normalizeGenerationSpec(input: unknown): GenerationSpec {
  const parsed = generationSpecSchema.parse(input);
  return {
    ...parsed,
    intent: { ...parsed.intent, mood: cleanList(parsed.intent.mood) },
    composition: { ...parsed.composition, sections: cleanList(parsed.composition.sections) },
    sound: {
      ...parsed.sound,
      styles: cleanList(parsed.sound.styles),
      exclusions: cleanList(parsed.sound.exclusions),
      novelty: parsed.sound.novelty,
    },
  };
}

function durationText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}${remainder ? ` ${remainder} seconds` : ''}`;
}

export function compileLyriaPrompt(spec: GenerationSpec): string {
  const lines = [
    `Create a full-length ${spec.intent.instrumental ? 'instrumental composition' : 'song with vocals'}.`,
    `Purpose: ${spec.intent.purpose}.`,
    `Mood: ${spec.intent.mood.join(', ')}.`,
    `Narrative: ${spec.intent.narrative}.`,
    `Target duration: ${durationText(spec.intent.durationSeconds)}.`,
    spec.composition.bpm ? `Tempo: ${spec.composition.bpm} BPM.` : '',
    spec.composition.key ? `Key: ${spec.composition.key}.` : '',
    spec.composition.meter ? `Meter: ${spec.composition.meter}.` : '',
    `Structure: ${spec.composition.sections.join(' → ')}.`,
    `Arrangement: ${spec.composition.arrangement}.`,
    `Style vocabulary: ${spec.sound.styles.join(', ')}.`,
    `Novelty: ${spec.sound.novelty}/100; preserve coherence while avoiding generic choices.`,
    spec.performance.vocalRange ? `Vocal range: ${spec.performance.vocalRange}.` : '',
    spec.performance.timbre ? `Vocal timbre: ${spec.performance.timbre}.` : '',
    spec.performance.delivery ? `Vocal delivery: ${spec.performance.delivery}.` : '',
    spec.sound.exclusions.length ? `Avoid: ${spec.sound.exclusions.join(', ')}.` : '',
    spec.composition.lyrics ? `Use these exact section-tagged lyrics:\n${spec.composition.lyrics}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
```

- [ ] **Step 5: Verify domain tests and typecheck**

Run:

```powershell
npm run test:twi -- src/twi/domain/prompt.test.ts
npm run typecheck:twi
```

Expected: PASS.

- [ ] **Step 6: Commit the normalized domain**

```powershell
git add src/twi/domain
git commit -m "feat(twi): define generation specification"
```

---

### Task 3: Add the Creation Core D1 schema and migration plumbing

**Files:**
- Create: `twi-migration-001-creation-core.sql`
- Create: `scripts/twi-schema-behavior.test.mjs`
- Modify: `scripts/apply-migrations.mjs`
- Modify: `_redirects`
- Modify: `package.json`

- [ ] **Step 1: Write the failing migration behavior tests**

Create `scripts/twi-schema-behavior.test.mjs` using `node:sqlite`. Cover these exact assertions:

```js
test('job status rejects values outside the TWI state machine', () => {
  const db = freshDb();
  seedProjectAndSpec(db);
  assert.throws(() => db.prepare(
    `INSERT INTO twi_jobs (id, project_id, spec_id, kind, status, idempotency_key, created_at, updated_at)
     VALUES ('j1','p1','s1','full-song','unknown','key1',datetime('now'),datetime('now'))`
  ).run());
});

test('idempotency keys are unique', () => {
  const db = freshDb();
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'same-key');
  assert.throws(() => insertJob(db, 'j2', 'same-key'));
});

test('revisions form parent-linked branches without deleting siblings', () => {
  const db = freshDb();
  seedProjectAndSpec(db);
  db.exec(`INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
           VALUES ('r1','p1',NULL,'twi/p1/revisions/r1.json','a','root',datetime('now')),
                  ('r2','p1','r1','twi/p1/revisions/r2.json','b','A',datetime('now')),
                  ('r3','p1','r1','twi/p1/revisions/r3.json','c','B',datetime('now'));`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_project_revisions WHERE parent_revision_id='r1'`).get().n, 2);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run `node --test scripts/twi-schema-behavior.test.mjs`.

Expected: FAIL because `twi-migration-001-creation-core.sql` does not exist.

- [ ] **Step 3: Create the migration with guarded states and indexes**

Create `twi-migration-001-creation-core.sql` with these tables:

```sql
CREATE TABLE IF NOT EXISTS twi_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_revision_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','deleted')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twi_project_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES twi_project_revisions(id),
  snapshot_key TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twi_generation_specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  spec_json TEXT NOT NULL,
  spec_sha256 TEXT NOT NULL,
  rights_assertion_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twi_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL REFERENCES twi_generation_specs(id),
  kind TEXT NOT NULL CHECK (kind IN ('full-song','finish')),
  status TEXT NOT NULL CHECK (status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  phase TEXT,
  workflow_id TEXT,
  provider TEXT,
  model TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  estimate_json TEXT,
  actual_cost_usd REAL NOT NULL DEFAULT 0,
  output_manifest_json TEXT,
  retry_checkpoint TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS twi_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  phase TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS twi_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES twi_jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('image-reference','generation-raw','generation-master','generation-preview','provenance')),
  label TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_seconds REAL,
  sha256 TEXT NOT NULL,
  provenance_key TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('provisional','active','hidden','deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS twi_cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('estimate','provider','finishing','storage')),
  provider TEXT,
  model TEXT,
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  quantity REAL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twi_projects_updated ON twi_projects(lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_revisions_project ON twi_project_revisions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_jobs_project ON twi_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_job_events_job ON twi_job_events(job_id, id);
CREATE INDEX IF NOT EXISTS idx_twi_assets_project ON twi_assets(project_id, lifecycle_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_cost_events_job ON twi_cost_events(job_id, id);
```

- [ ] **Step 4: Register and hide the migration**

Extend the migration regex in `scripts/apply-migrations.mjs` to include `twi-migration`. Add this exact redirect:

```text
/twi-migration-001-creation-core.sql    /  301
```

Add `test:twi:schema` to `package.json`:

```json
"test:twi:schema": "node --test scripts/twi-schema-behavior.test.mjs"
```

- [ ] **Step 5: Verify schema behavior and dry-run discovery**

Run:

```powershell
npm run test:twi:schema
npm run db:migrate:dry
```

Expected: schema tests PASS; dry run lists `twi-migration-001-creation-core.sql` exactly once.

- [ ] **Step 6: Commit the schema**

```powershell
git add twi-migration-001-creation-core.sql scripts/twi-schema-behavior.test.mjs scripts/apply-migrations.mjs _redirects package.json
git commit -m "feat(twi): add Creation Core schema"
```

---

### Task 4: Implement job-state rules and the D1 repository boundary

**Files:**
- Create: `src/twi/domain/job-state.ts`
- Create: `src/twi/domain/job-state.test.ts`
- Create: `src/twi/server/repository.ts`
- Create: `src/twi/server/repository.test.ts`

- [ ] **Step 1: Write failing state-transition tests**

Cover the happy path, cancellation, retry, and forbidden terminal transitions:

```ts
expect(canTransition('queued', 'generating')).toBe(true);
expect(canTransition('generating', 'cancelling')).toBe(true);
expect(canTransition('error', 'retrying')).toBe(true);
expect(canTransition('complete', 'generating')).toBe(false);
expect(() => assertTransition('complete', 'error')).toThrow('complete → error');
```

- [ ] **Step 2: Run the state test and verify it fails**

Run `npm run test:twi -- src/twi/domain/job-state.test.ts`.

Expected: FAIL because `job-state.ts` does not exist.

- [ ] **Step 3: Implement the explicit transition map**

Create `src/twi/domain/job-state.ts`:

```ts
import type { JobStatus } from './types';

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  draft: ['estimated'],
  estimated: ['queued'],
  queued: ['generating', 'cancelling', 'error'],
  generating: ['ingesting', 'cancelling', 'error'],
  ingesting: ['finishing', 'cancelling', 'error'],
  finishing: ['validating', 'cancelling', 'error'],
  validating: ['complete', 'error'],
  complete: [],
  cancelling: ['cancelled', 'complete', 'error'],
  cancelled: [],
  error: ['retrying'],
  retrying: ['queued', 'generating', 'ingesting', 'finishing', 'validating', 'error'],
};

export const isTerminal = (status: JobStatus) => ['complete', 'cancelled', 'error'].includes(status);
export const canTransition = (from: JobStatus, to: JobStatus) => transitions[from].includes(to);
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal TWI job transition: ${from} → ${to}`);
}
```

- [ ] **Step 4: Define a repository interface that can be tested without Workers globals**

In `src/twi/server/repository.ts`, export `TwiRepository` with methods `listProjects`, `createProject`, `getProject`, `saveSpec`, `findJobByIdempotencyKey`, `createEstimatedJob`, `transitionJob`, `appendCost`, `registerAsset`, and `publishCandidates`. Export `D1TwiRepository` implementing those methods with prepared statements.

`transitionJob` must read the current status, call `assertTransition`, then execute a D1 batch containing the guarded update and `twi_job_events` insert. Treat `meta.changes !== 1` as a conflict.

Use this exact guarded update shape:

```ts
env.DB.prepare(
  `UPDATE twi_jobs
   SET status = ?, phase = ?, updated_at = MAX(updated_at, ?), error_code = ?, error_message = ?
   WHERE id = ? AND status = ?`
).bind(to, phase, now, errorCode, errorMessage, jobId, from)
```

`updated_at` is assigned `MAX(updated_at, ?)` rather than `?` so a transition carrying an older `now` cannot roll back a newer timestamp written by a concurrent `appendCost`, which advances the same column the same way; because `MAX()` over TEXT is a lexicographic comparison in which any non-ISO string (`'now'`, a bare epoch number, a `+02:00` offset) would outrank every real date and latch the column permanently, every timestamp entering the repository must first pass strict `YYYY-MM-DDTHH:MM:SS.sssZ` validation.

- [ ] **Step 5: Add a fake D1 unit test for guarded transitions**

Create `src/twi/server/repository.test.ts` with a narrow fake DB that records SQL/bindings and reports `{ meta: { changes: 1 } }`. Assert the update binds `from` as the final argument and that a zero-change result throws `job transition conflict`.

- [ ] **Step 6: Run domain/repository tests**

Run:

```powershell
npm run test:twi -- src/twi/domain/job-state.test.ts src/twi/server/repository.test.ts
npm run typecheck:twi
```

Expected: PASS.

- [ ] **Step 7: Commit repository and state machine**

```powershell
git add src/twi/domain/job-state* src/twi/server/repository*
git commit -m "feat(twi): add durable job repository"
```

---

### Task 5: Implement the authenticated TWI Projects and Bootstrap API

**Files:**
- Create: `src/twi/server/http.ts`
- Create: `src/twi/server/auth.ts`
- Create: `src/twi/server/capabilities.ts`
- Create: `src/twi/server/projects.ts`
- Create: `functions/api/twi/[[route]].ts`
- Create: `scripts/twi-contract-check.mjs`
- Modify: `package.json`
- Modify: `_redirects`

- [ ] **Step 1: Write failing route-contract checks**

Create `scripts/twi-contract-check.mjs` and assert:

```js
check('nested TWI route exists', fs.existsSync(path.join(root, 'functions/api/twi/[[route]].ts')));
check('all owner routes call requireOwnerSession', /await requireOwnerSession\(request, env\)/.test(route));
check('bootstrap route is GET only', /resource === 'bootstrap'[\s\S]{0,100}method === 'GET'/.test(route));
check('project create route is POST only', /resource === 'projects'[\s\S]{0,180}method === 'POST'/.test(route));
check('TWI app has an SPA rewrite', /^\/twi\/\*\s+\/twi\/index\.html\s+200$/m.test(redirects));
check('orchestrator source is blocked', /^\/twi-orchestrator\/\*\s+\/\s+301$/m.test(redirects));
```

- [ ] **Step 2: Run the contract check and verify it fails**

Run `node scripts/twi-contract-check.mjs`.

Expected: FAIL because route and redirects are absent.

- [ ] **Step 3: Implement shared HTTP/auth helpers**

`src/twi/server/http.ts` exports `json`, `HttpError`, `getCookie`, `assertSameOriginMutation`, and `parseJson`. `assertSameOriginMutation` must compare the `Origin` header to `new URL(request.url).origin` for non-GET/HEAD methods and throw `HttpError(403, 'origin mismatch')` when absent or different.

`src/twi/server/auth.ts` must reuse the same `session` cookie and query as the current parent route:

```ts
export async function requireOwnerSession(request: Request, env: Pick<TwiEnv, 'DB'>): Promise<void> {
  const token = getCookie(request, 'session');
  if (!token) throw new HttpError(401, 'Unauthorized');
  const row = await env.DB.prepare(
    `SELECT token FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')`
  ).bind(token).first();
  if (!row) throw new HttpError(401, 'Unauthorized');
}
```

- [ ] **Step 4: Implement project use cases and capability catalog**

`src/twi/server/capabilities.ts` returns:

```ts
export const creationCoreCapabilities = {
  provider: 'lyria-3-pro',
  fullSong: true,
  customLyrics: true,
  imageReference: true,
  audioReference: false,
  midiReference: false,
  deterministicSeed: false,
  maxImageReferences: 10,
  outputFormats: ['audio/wav'] as const,
};
```

`src/twi/server/projects.ts` exports list/create/get functions. Project names are trimmed, required, and capped at 120 characters. Creation uses `crypto.randomUUID()` and ISO timestamps.

- [ ] **Step 5: Implement the nested Pages Function**

Define this route table in `functions/api/twi/[[route]].ts` after `requireOwnerSession` and same-origin mutation validation:

```ts
if (resource === 'bootstrap' && !id && method === 'GET') return json({ capabilities: creationCoreCapabilities });
if (resource === 'projects' && !id && method === 'GET') return listProjects(repo);
if (resource === 'projects' && !id && method === 'POST') return createProject(request, repo);
if (resource === 'projects' && id && method === 'GET') return getProject(id, repo);
return json({ error: 'not found', code: 'not_found' }, 404);
```

The catch block returns `{ error, code }` for `HttpError`; unexpected errors log the correlation ID and return `internal_error` without stack or secret values.

- [ ] **Step 6: Add routing and source protections**

Add:

```text
/twi       /twi/index.html  200
/twi/*     /twi/index.html  200
/twi-orchestrator/*  /  301
```

Add `test:twi:contracts` to `package.json` and include it in the root `test` command after `test:stems`.

- [ ] **Step 7: Verify contracts and existing tests**

Run:

```powershell
npm run build:twi
npm run test:twi:contracts
npm test
```

Expected: all PASS; existing routes remain unchanged.

- [ ] **Step 8: Commit the first TWI API**

```powershell
git add src/twi/server functions/api/twi scripts/twi-contract-check.mjs package.json _redirects twi
git commit -m "feat(twi): add private project API"
```

---

### Task 6: Add image-reference asset ingestion

**Files:**
- Create: `src/twi/server/assets.ts`
- Create: `src/twi/server/assets.test.ts`
- Modify: `functions/api/twi/[[route]].ts`
- Modify: `scripts/twi-contract-check.mjs`

- [ ] **Step 1: Write failing validation tests**

Test acceptance of JPEG/PNG/WebP magic bytes and rejection of extension-only spoofing, files over 10 MiB, non-image content, and more than ten references per specification.

Use fixtures created in memory:

```ts
const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'mood.jpg', { type: 'image/jpeg' });
await expect(validateImageReference(jpeg)).resolves.toMatchObject({ extension: 'jpg', contentType: 'image/jpeg' });
```

- [ ] **Step 2: Run tests and verify failure**

Run `npm run test:twi -- src/twi/server/assets.test.ts`.

Expected: FAIL because `assets.ts` does not exist.

- [ ] **Step 3: Implement strict image ingestion**

`validateImageReference` must inspect the first 16 bytes and return only `jpg`, `png`, or `webp`. `createImageAsset` writes the object to `twi/{projectId}/assets/{assetId}/source.{ext}`, calculates SHA-256 with Web Crypto, then inserts `twi_assets` only after `R2.put` succeeds. On D1 failure, delete the just-written R2 object before rethrowing.

- [ ] **Step 4: Add the upload route**

Add `POST /api/twi/projects/:projectId/assets` accepting multipart field `file`. Require owner auth and same-origin mutation. Return status 201 with the asset record and no raw R2 credentials.

- [ ] **Step 5: Add contract assertions**

Assert the route calls `validateImageReference`, uses the `twi/` R2 prefix, caps upload bytes at `10 * 1024 * 1024`, and never returns `env.FILES` or a secret.

- [ ] **Step 6: Verify tests and commit**

Run `npm run test:twi -- src/twi/server/assets.test.ts && npm run test:twi:contracts`, then:

```powershell
git add src/twi/server/assets* functions/api/twi scripts/twi-contract-check.mjs
git commit -m "feat(twi): add image reference assets"
```

---

### Task 7: Implement estimate, idempotent submit, polling, cancel and retry APIs

**Files:**
- Create: `src/twi/server/jobs.ts`
- Create: `src/twi/server/jobs.test.ts`
- Modify: `functions/api/twi/[[route]].ts`
- Modify: `src/twi/server/repository.ts`

- [ ] **Step 1: Write failing estimate/idempotency tests**

Cover:

```ts
expect(estimate.total).toBeCloseTo(estimate.provider + estimate.finishing + estimate.storage, 8);
expect(await submitTwiceWithSameKey()).toEqual({ firstJobId: 'j1', secondJobId: 'j1', starts: 1 });
await expect(submitWithoutAcceptedRights()).rejects.toMatchObject({ status: 400 });
await expect(submitWithAudioReferenceAgainstLyria()).rejects.toMatchObject({ code: 'unsupported_capability' });
```

- [ ] **Step 2: Run and verify the red state**

Run `npm run test:twi -- src/twi/server/jobs.test.ts`.

Expected: FAIL because job use cases do not exist.

- [ ] **Step 3: Implement estimates as an injectable policy**

Define:

```ts
export interface EstimatePolicy {
  estimate(spec: GenerationSpec): Promise<CostEstimate>;
}

export const fixedCreationCoreEstimate: EstimatePolicy = {
  async estimate() {
    const provider = 0; // Gemini preview pricing is not hard-coded until billing returns a stable published rate.
    const finishing = 0.04;
    const storage = 0.01;
    return { currency: 'USD', provider, finishing, storage, total: provider + finishing + storage, estimatedSeconds: 360 };
  },
};
```

The response must label the provider component `unavailable` when its amount is zero because pricing is not configured; confirmation text must state that actual provider cost will still be recorded. Production deployment may set `TWI_LYRIA_ESTIMATE_USD` and the policy parses a non-negative number.

- [ ] **Step 4: Implement idempotent submission**

Submission flow:

1. Parse and normalize the spec.
2. Verify referenced assets belong to the project and match capabilities.
3. Hash normalized JSON with SHA-256.
4. Return an existing job when `idempotency_key` already exists.
5. Insert spec, estimated job, estimate cost event and job event.
6. Call `env.TWI_ORCHESTRATOR.fetch('https://twi.internal/start', …)`.
7. Transition `estimated → queued` only after a successful internal response.
8. On dispatch failure, transition to `error` with `orchestrator_unavailable`; do not create a second paid submission during retry.

- [ ] **Step 5: Add exact routes**

```text
POST /api/twi/jobs/estimate
POST /api/twi/jobs
GET  /api/twi/jobs
GET  /api/twi/jobs/:id
POST /api/twi/jobs/:id/cancel
POST /api/twi/jobs/:id/retry
```

Cancel calls the orchestrator and moves to `cancelling`; retry is allowed only from `error` and preserves the original frozen spec/idempotency lineage.

- [ ] **Step 6: Verify tests and commit**

Run `npm run test:twi -- src/twi/server/jobs.test.ts src/twi/domain/job-state.test.ts` and `npm run test:twi:contracts`.

```powershell
git add src/twi/server/jobs* src/twi/server/repository.ts functions/api/twi
git commit -m "feat(twi): add durable creation job API"
```

---

### Task 8: Build the Workflow Worker with a deterministic fake provider

**Files:**
- Create: `twi-orchestrator/package.json`
- Create: `twi-orchestrator/tsconfig.json`
- Create: `twi-orchestrator/wrangler.toml`
- Create: `twi-orchestrator/src/index.ts`
- Create: `twi-orchestrator/src/workflow.ts`
- Create: `twi-orchestrator/src/providers/types.ts`
- Create: `twi-orchestrator/src/providers/fake.ts`
- Create: `twi-orchestrator/src/audio/wav.ts`
- Create: `twi-orchestrator/src/audio/wav.test.ts`
- Create: `twi-orchestrator/src/db.ts`
- Create: `twi-orchestrator/test/workflow.test.ts`

- [ ] **Step 1: Add the Worker package and tests**

Create `twi-orchestrator/package.json`:

```json
{
  "name": "twi-orchestrator",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260815.1",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8",
    "wrangler": "^4.123.0"
  }
}
```

Run `npm install --prefix twi-orchestrator`.

- [ ] **Step 2: Write the failing deterministic WAV test**

```ts
const first = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 });
const second = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 });
expect(first).toEqual(second);
expect(new TextDecoder().decode(first.slice(0, 4))).toBe('RIFF');
expect(new TextDecoder().decode(first.slice(8, 12))).toBe('WAVE');
```

- [ ] **Step 3: Run and verify failure**

Run `npm test --prefix twi-orchestrator -- src/audio/wav.test.ts`.

Expected: FAIL because `wav.ts` does not exist.

- [ ] **Step 4: Implement the fake provider contract**

`providers/types.ts` exports:

```ts
export interface ProviderCandidate {
  label: 'A' | 'B';
  bytes: Uint8Array;
  contentType: 'audio/wav';
  provider: string;
  model: string;
  durationSeconds: number;
  providerCostUsd: number;
  providerRequestId: string;
}

export interface MusicProvider {
  generate(spec: GenerationSpec, label: 'A' | 'B'): Promise<ProviderCandidate>;
}
```

`fake.ts` uses `createSineWav`; A is 220 Hz and B is 277.18 Hz. It returns provider `fake`, model `deterministic-sine-v1`, cost 0, and stable request ID `${specHash}-${label}`.

- [ ] **Step 5: Implement Workflow and internal service routes**

`wrangler.toml` defines D1, R2, queue producer/consumer, and:

```toml
[[workflows]]
name = "twi-render-workflow"
binding = "TWI_RENDER_WORKFLOW"
class_name = "TwiRenderWorkflow"
```

`index.ts` exposes internal `/start`, `/status/:id`, `/cancel/:id`, and `/callback/modal`. `/start` calls:

```ts
await env.TWI_RENDER_WORKFLOW.create({ id: body.jobId, params: body });
```

`workflow.ts` must execute named steps `load-job`, `generate-A`, `generate-B`, `persist-raw`, `finish`, `validate`, and `publish`. Each generation step writes raw audio to R2 inside the same `step.do` callback and returns only a small manifest; no base64 audio crosses a Workflow step boundary.

The fake-provider path skips Modal finishing and writes the same deterministic WAV bytes as raw, master, and preview assets with `audio/wav` content types. This test-only shortcut keeps every fake artifact playable without pretending it passed production encoding. Production mode must not use that skip.

- [ ] **Step 6: Test atomic publication and duplicate start**

The Workflow test must prove assets remain `provisional` until both candidates validate, both become `active` in one D1 batch, and a second `/start` using the same job ID returns the existing Workflow rather than running generation again.

- [ ] **Step 7: Verify Worker tests/typecheck**

Run:

```powershell
npm test --prefix twi-orchestrator
npm run typecheck --prefix twi-orchestrator
```

Expected: PASS.

- [ ] **Step 8: Commit the fake end-to-end orchestrator**

```powershell
git add twi-orchestrator
git commit -m "feat(twi): add durable render workflow"
```

---

### Task 9: Implement the official Lyria 3 Pro adapter

**Files:**
- Create: `twi-orchestrator/src/providers/lyria.ts`
- Create: `twi-orchestrator/src/providers/lyria.test.ts`
- Modify: `twi-orchestrator/src/workflow.ts`
- Modify: `twi-orchestrator/src/providers/types.ts`

- [ ] **Step 1: Write failing request/response contract tests**

Mock `fetch` and assert the adapter sends:

```json
{
  "model": "lyria-3-pro-preview",
  "input": "<compiled prompt>",
  "response_format": { "type": "audio" }
}
```

to `https://generativelanguage.googleapis.com/v1beta/interactions`, with `x-goog-api-key`, and extracts the `audio` block from `model_output` steps. Also test missing audio, non-2xx response, malformed base64, and Google safety rejection as stable error codes.

- [ ] **Step 2: Run and verify the red state**

Run `npm test --prefix twi-orchestrator -- src/providers/lyria.test.ts`.

Expected: FAIL because `lyria.ts` does not exist.

- [ ] **Step 3: Implement the adapter without logging prompts or keys**

The adapter constructor receives `{ apiKey, fetchImpl }`. It compiles the normalized prompt, adds image content blocks loaded from R2 when present, requests WAV, validates that the decoded payload starts with `RIFF`/`WAVE`, and returns a `ProviderCandidate`.

Use this error shape:

```ts
export class ProviderError extends Error {
  constructor(public code: 'provider_rejected' | 'provider_unavailable' | 'provider_invalid_audio', message: string, public charged: boolean | null) {
    super(message);
  }
}
```

Do not include the prompt, response body, or API key in error messages.

- [ ] **Step 4: Select the adapter through environment configuration**

`TWI_PROVIDER_MODE=fake|lyria`; deployment defaults to no provider and refuses `/start` with `provider_not_configured`. Only local/test configuration explicitly selects `fake`. `lyria` requires `GEMINI_API_KEY`.

- [ ] **Step 5: Verify tests and commit**

Run Worker tests/typecheck, then:

```powershell
git add twi-orchestrator/src/providers twi-orchestrator/src/workflow.ts
git commit -m "feat(twi): add official Lyria provider adapter"
```

---

### Task 10: Add the Modal maximum-quality finishing job

**Files:**
- Create: `stems-gpu/finish.py`
- Create: `stems-gpu/test_finish.py`
- Modify: `stems-gpu/app.py`
- Modify: `stems-gpu/README.md`

- [ ] **Step 1: Write failing pure command/manifest tests**

`test_finish.py` must assert that `build_finish_commands` produces a two-pass EBU R128 loudness analysis/render at `-14 LUFS`, maximum true peak `-1 dBTP`, FLAC master, 320-kbps MP3 preview, and TWI R2 keys under the provided output prefix. It must reject prefixes that do not match `^twi/[0-9a-f-]+/assets/[0-9a-f-]+$`.

- [ ] **Step 2: Run and verify failure**

Run `python stems-gpu/test_finish.py`.

Expected: FAIL because `finish.py` does not exist.

- [ ] **Step 3: Implement finishing helpers**

`finish.py` exports `validate_output_prefix`, `probe_audio`, `run_two_pass_loudnorm`, and `build_finish_manifest`. The manifest contains raw/master/preview keys, bytes, content types, duration, integrated loudness and true peak. Use `subprocess.run([...], check=True)` argument arrays; never compose shell strings.

- [ ] **Step 4: Add the asynchronous Modal function and endpoint**

Add `finish_job` to `app.py`. It downloads the TWI raw object through a signed/internal URL, decodes it with FFmpeg, runs two-pass loudness normalization, writes FLAC and MP3, uploads directly to R2, posts a signed callback, and returns `{ "kind": "finish", "manifest": ... }`.

Add `POST /finish/jobs`. Extend `/status/{call_id}` to return either `stems` or `manifest` without changing the current Stem Lab response shape.

- [ ] **Step 5: Verify Python tests and syntax**

Run:

```powershell
python stems-gpu/test_registry.py
python stems-gpu/test_finish.py
python -m py_compile stems-gpu/app.py stems-gpu/registry.py stems-gpu/finish.py
```

Expected: all PASS.

- [ ] **Step 6: Commit finishing support**

```powershell
git add stems-gpu/app.py stems-gpu/finish.py stems-gpu/test_finish.py stems-gpu/README.md
git commit -m "feat(twi): add maximum-quality finishing job"
```

---

### Task 11: Connect the Workflow to Modal finishing and validation

**Files:**
- Modify: `twi-orchestrator/src/workflow.ts`
- Modify: `twi-orchestrator/src/index.ts`
- Modify: `twi-orchestrator/src/db.ts`
- Modify: `twi-orchestrator/test/workflow.test.ts`

- [ ] **Step 1: Write failing finishing/callback tests**

Assert the Workflow submits one finishing job per candidate with `X-Stems-Secret`, waits for a `modal-finished-{label}` event, validates manifest keys/checksums, and refuses to publish if either callback is missing or invalid. A duplicate callback must be a no-op.

- [ ] **Step 2: Run and verify failure**

Run `npm test --prefix twi-orchestrator -- test/workflow.test.ts`.

Expected: FAIL because finishing waits/events are absent.

- [ ] **Step 3: Implement event-driven finishing**

For each candidate:

```ts
const call = await step.do(`submit-finish-${label}`, { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } }, () => submitFinish(...));
const result = await step.waitForEvent(`wait-finish-${label}`, {
  type: `modal-finished-${label}`,
  timeout: '30 minutes',
});
await step.do(`validate-${label}`, () => validateFinishManifest(call, result.payload));
```

The internal callback route validates the shared secret, job/asset IDs, R2 prefix, replay timestamp and callback ID, then calls `instance.sendEvent`. Store callback IDs in `twi_job_events.detail_json` so replayed callbacks return 200 without a second event.

- [ ] **Step 4: Implement automated audio manifest validation**

Require master FLAC and MP3 preview, positive duration/bytes, `-1.5 <= truePeakDbtp <= -0.5`, and `-15 <= integratedLufs <= -13`. Reject missing objects after an R2 `head` check.

- [ ] **Step 5: Verify Workflow tests and commit**

```powershell
npm test --prefix twi-orchestrator
npm run typecheck --prefix twi-orchestrator
git add twi-orchestrator
git commit -m "feat(twi): finish and validate generated candidates"
```

---

### Task 12: Implement the typed API client and project library

**Files:**
- Create: `src/twi/api/client.ts`
- Create: `src/twi/api/client.test.ts`
- Create: `src/twi/store/useTwiStore.ts`
- Create: `src/twi/features/library/Library.tsx`
- Create: `src/twi/features/library/Library.test.tsx`
- Modify: `src/twi/app/App.tsx`
- Modify: `src/twi/app/app.css`

- [ ] **Step 1: Write failing API error and library tests**

Test that a non-JSON 500 becomes `TwiApiError('internal_error')`, 401 becomes an auth-denied state, the project list renders sorted results, and creating a project opens the wizard with the returned project ID.

- [ ] **Step 2: Run and verify failure**

Run `npm run test:twi -- src/twi/api/client.test.ts src/twi/features/library/Library.test.tsx`.

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement the typed client**

Use one request helper:

```ts
export async function twiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/twi${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-TWI-Request': 'same-origin', ...init.headers },
  });
  const body = await response.json().catch(() => ({ error: response.statusText, code: 'invalid_response' }));
  if (!response.ok) throw new TwiApiError(response.status, body.code ?? 'request_failed', body.error ?? 'Request failed');
  return body as T;
}
```

Do not set `Content-Type` for `FormData` uploads.

- [ ] **Step 4: Implement store and library**

The store holds auth, capabilities, projects, selected project, wizard draft, active job and candidates. It contains actions only; network calls remain in feature hooks/client functions.

Library cards show name, updated time and last job status. The primary button is `New research session`.

- [ ] **Step 5: Verify tests, accessibility and commit**

Run tests, typecheck and build. Confirm buttons have accessible names and empty/error states have retry actions.

```powershell
git add src/twi/api src/twi/store src/twi/features/library src/twi/app twi
git commit -m "feat(twi): add private project library"
```

---

### Task 13: Implement the five-stage creation wizard and confirmation gate

**Files:**
- Create: `src/twi/features/wizard/Wizard.tsx`
- Create: `src/twi/features/wizard/Wizard.test.tsx`
- Create: `src/twi/features/wizard/steps/IntentStep.tsx`
- Create: `src/twi/features/wizard/steps/CompositionStep.tsx`
- Create: `src/twi/features/wizard/steps/SoundStep.tsx`
- Create: `src/twi/features/wizard/steps/PerformanceStep.tsx`
- Create: `src/twi/features/wizard/steps/CommitStep.tsx`
- Create: `src/twi/features/jobs/JobProgress.tsx`
- Create: `src/twi/features/jobs/JobProgress.test.tsx`
- Modify: `src/twi/app/app.css`

- [ ] **Step 1: Write failing wizard behavior tests**

Cover one topic per test: required intent validation, custom lyrics persistence when navigating back, unsupported audio/MIDI explanation, image upload limit, rights checkbox requirement, estimate rendering with “provider cost unavailable,” double-click submission producing one request, and phase-specific progress text.

- [ ] **Step 2: Run and verify failure**

Run `npm run test:twi -- src/twi/features/wizard/Wizard.test.tsx src/twi/features/jobs/JobProgress.test.tsx`.

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement the stage coordinator**

`Wizard.tsx` owns only current-stage navigation and delegates fields. Persist draft state in Zustand and `sessionStorage` under `twi:draft:{projectId}` after every valid field update. Clear it only after the server accepts the job.

Use semantic `<fieldset>`/`<legend>` groups, a visible `Step N of 5`, Back/Continue buttons, and an expert `Review all parameters` disclosure.

- [ ] **Step 4: Implement exact stage responsibilities**

- `IntentStep`: purpose, mood tags, narrative, duration, instrumental toggle.
- `CompositionStep`: lyrics editor, section tags, BPM, key, meter, arrangement.
- `SoundStep`: styles, exclusions, novelty slider, up to ten image uploads; disabled audio/MIDI controls with `Current provider does not support this reference type`.
- `PerformanceStep`: generic range, timbre and delivery; personal profiles show `Available in AI Co-producer phase` and do not submit placeholder IDs.
- `CommitStep`: normalized summary, provider/model/capabilities, time/cost breakdown, rights assertion, exact `Generate two candidates` action.

- [ ] **Step 5: Prevent duplicate paid submissions**

Generate one UUID idempotency key when the Commit step first loads. Reuse it for every retry until the server returns a job. Disable submit while the request is in flight.

- [ ] **Step 6: Implement accessible progress and failure actions**

`JobProgress` maps every job phase to specific copy and displays estimate, actual cost, charged status, elapsed time, cancel/retry when legal, and a polling interval that backs off from 2 to 10 seconds. Stop polling terminal jobs and while the document is hidden; refresh immediately when visible again.

- [ ] **Step 7: Verify tests and commit**

Run TWI tests/typecheck/build, then:

```powershell
git add src/twi/features/wizard src/twi/features/jobs src/twi/app/app.css twi
git commit -m "feat(twi): add guided creation protocol"
```

---

### Task 14: Implement synchronized candidate review and immutable branching

**Files:**
- Create: `src/twi/features/candidates/SyncedPlayer.tsx`
- Create: `src/twi/features/candidates/SyncedPlayer.test.tsx`
- Create: `src/twi/features/candidates/CandidateReview.tsx`
- Create: `src/twi/features/candidates/CandidateReview.test.tsx`
- Modify: `src/twi/api/client.ts`
- Modify: `src/twi/app/app.css`
- Modify: `functions/api/twi/[[route]].ts`
- Modify: `src/twi/server/projects.ts`

- [ ] **Step 1: Write failing playback and branch tests**

Test that Play starts both audio elements from the same time, A/B buttons change audible gain without resetting position, seek updates both, unmount pauses both, master downloads use server URLs, and selecting Candidate B posts one immutable revision commit referencing B's master asset.

- [ ] **Step 2: Run and verify failure**

Run the two candidate test files.

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement synchronized playback**

Use two `<audio preload="metadata">` elements. On play and every 500 ms while playing, correct drift greater than 40 ms by assigning the leader's `currentTime` to the follower. Implement blind mode by hiding labels until a choice is recorded. Loudness is already matched by finishing; the client only crossfades gains over 50 ms.

- [ ] **Step 4: Implement candidate review metadata and actions**

Show duration, provider/model, actual cost, latency, prompt/spec checksum, provenance download, master download, regenerate, separate stems, and `Open selected candidate`. Regenerate returns to Commit with a new idempotency key and preserved frozen draft.

- [ ] **Step 5: Implement the Phase 1 revision commit endpoint**

Add `POST /api/twi/projects/:id/revisions`. Validate that the selected asset belongs to the project, is active, and is a `generation-master`. Write this snapshot to R2:

```json
{
  "schemaVersion": 1,
  "projectId": "<id>",
  "sourceCandidateAssetId": "<asset-id>",
  "tracks": [{ "id": "master", "name": "Master", "assetId": "<asset-id>", "startSeconds": 0 }]
}
```

Insert the revision and update `current_revision_id` in a D1 batch. Sibling revisions remain intact.

- [ ] **Step 6: Verify candidate tests and commit**

```powershell
npm run test:twi -- src/twi/features/candidates
npm run typecheck:twi
git add src/twi/features/candidates src/twi/api/client.ts src/twi/app/app.css functions/api/twi src/twi/server/projects.ts
git commit -m "feat(twi): add candidate review and branching"
```

---

### Task 15: Harden headers, integration contracts, browser E2E and runbooks

**Files:**
- Create: `playwright.twi.config.ts`
- Create: `test/twi/creation-core.spec.ts`
- Create: `scripts/twi-e2e-api.mjs`
- Create: `docs/twi/creation-core-runbook.md`
- Modify: `_headers`
- Modify: `wrangler.toml`
- Modify: `package.json`
- Modify: `PROJECT.md`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing E2E contract**

Install the pinned browser-test dependency:

```powershell
npm install --save-dev @playwright/test@1.62.1
npx playwright install chromium
```

Create `playwright.twi.config.ts` with `testDir: './test/twi'`, `use.baseURL: 'http://127.0.0.1:4179'`, a Chromium project, trace retention on first retry, and two `webServer` entries: `npm run twi:e2e:api` on port 4178 and `npm run preview:twi -- --host 127.0.0.1 --port 4179` on port 4179.

Create `test/twi/creation-core.spec.ts`. The Playwright test exercises a production-built `/twi/` app against the deterministic fake API fixture: authenticated bootstrap, create project, complete five stages, estimate, submit, queued→complete polling, render two candidates, select B, commit revision, and reopen the project. A second test activates the error fixture, clicks Retry, and asserts the request retains the original idempotency lineage and creates no duplicate cost/provider event.

- [ ] **Step 2: Run and verify failure**

Create `scripts/twi-e2e-api.mjs` as a deterministic HTTP fixture server on `127.0.0.1:4178`. It must implement `/api/auth/check` and every `/api/twi/*` route used by the two journeys, retain projects/jobs/events in memory, advance job status once per poll, and expose `/__fixture__/error` plus `/__fixture__/state` for error activation and duplicate-event assertions. Configure Vite preview to proxy `/api` to port 4178 in `vite.twi.config.ts`.

Run `npx playwright test --config playwright.twi.config.ts`.

Expected: FAIL before the test harness/build integration is complete.

- [ ] **Step 3: Update site security policy deliberately**

Change the global `Permissions-Policy` from `microphone=()` to `microphone=(self)` because recording arrives in Phase 2 and the approved desktop studio requires it. Add `worker-src 'self' blob:` to CSP for future AudioWorklets/Web Workers. Add the exact R2 host used for direct media only when direct signed transfers are introduced; Phase 1 image uploads remain same-origin and do not widen `connect-src`.

Do not add `unsafe-eval`, `wasm-unsafe-eval`, wildcard providers, or browser access to Gemini/Modal.

- [ ] **Step 4: Configure the Pages-to-Worker service binding**

Document `TWI_ORCHESTRATOR` as a Pages service binding to the deployed `twi-orchestrator` Worker. Add its TypeScript binding to the TWI route Env. `wrangler.toml` retains existing D1/R2 bindings; do not place `GEMINI_API_KEY` or the Modal secret in Pages configuration.

- [ ] **Step 5: Wire final commands**

Add:

```json
"preview:twi": "vite preview --config vite.twi.config.ts",
"twi:e2e:api": "node scripts/twi-e2e-api.mjs",
"test:twi:e2e": "npm run build:twi && playwright test --config playwright.twi.config.ts",
"test:twi:all": "npm run test:twi && npm run test:twi:schema && npm run test:twi:contracts && npm run test:twi:e2e && npm test --prefix twi-orchestrator"
```

Append `&& npm run test:twi:all` to the existing root `test` script. `test:twi:all` invokes only named TWI suites and the orchestrator subpackage, never root `npm test`, so the sequence terminates and runs every prior test once.

- [ ] **Step 6: Write the runbook with exact external setup**

`docs/twi/creation-core-runbook.md` must document:

1. D1 migration command.
2. Orchestrator install/test/deploy commands.
3. `GEMINI_API_KEY`, `TWI_PROVIDER_MODE`, `TWI_LYRIA_ESTIMATE_USD`, `STEMS_PROXY_SECRET`, `STEMS_MODAL_URL`, D1 and R2 bindings.
4. Pages `TWI_ORCHESTRATOR` service binding.
5. Local fake-provider mode and the fact that production refuses fake mode.
6. Modal finishing deployment.
7. A live smoke test and rollback procedure.
8. Cost and stuck-job queries against `twi_jobs`/`twi_cost_events`.

- [ ] **Step 7: Update project knowledge and ignore generated state**

Add TWI route/stack/tests/deploy flow to `PROJECT.md`. Add `.superpowers/` and local orchestrator `.wrangler/` paths to `.gitignore`; do not ignore `twi/` because Pages deploys the generated static assets from the repository root.

- [ ] **Step 8: Run the complete local quality gate**

Run:

```powershell
npm run typecheck:twi
npm run build
npm run test:twi:all
npm test
python stems-gpu/test_registry.py
python stems-gpu/test_finish.py
python -m py_compile stems-gpu/app.py stems-gpu/registry.py stems-gpu/finish.py
npm run db:migrate:dry
git diff --check
```

Expected: every command exits 0; migration dry-run lists Creation Core once; generated files are confined to `twi/`; no secrets or local `.wrangler` data appear in `git status`.

- [ ] **Step 9: Perform the manual browser acceptance test**

With local D1/R2 and fake provider:

1. Authenticate through the existing SP1E login.
2. Open `/twi/` at 1440×900 and 390×844.
3. Create a project and finish every wizard stage using custom lyrics.
4. Confirm the exact estimate and submit once with a double-click attempt.
5. Observe every explicit job phase.
6. Play A/B in sync, seek, use blind mode, download both masters and provenance.
7. Select B, reopen the project, and confirm the revision references B.
8. Force the fake error fixture, retry, and confirm no duplicate cost/provider event.
9. Navigate only by keyboard and verify visible focus and reduced-motion behavior.

Expected: all nine checks pass without console errors, duplicate jobs, missing metadata, or silent failures.

- [ ] **Step 10: Commit Creation Core integration**

```powershell
git add _headers wrangler.toml package.json package-lock.json playwright.twi.config.ts test/twi scripts/twi-e2e-api.mjs docs/twi PROJECT.md .gitignore twi vite.twi.config.ts
git commit -m "feat(twi): complete Creation Core release"
```

---

## Final review checklist

- [ ] Every job is owner-authenticated and mutation requests are same-origin checked.
- [ ] The same idempotency key cannot produce two provider submissions.
- [ ] Raw audio, masters, previews and provenance use immutable R2 keys.
- [ ] Candidate assets remain provisional until both candidates pass validation.
- [ ] Estimate and actual cost remain visible on success, failure and cancellation.
- [ ] The UI never claims audio/MIDI reference support from the Lyria adapter.
- [ ] Production cannot select the deterministic fake provider accidentally.
- [ ] Existing `/stems/` routes, tests and UI remain functional.
- [ ] Existing SP1E pages do not load React or TWI assets.
- [ ] No provider prompt, API key, raw response or enrollment material enters logs.
- [ ] The complete test and manual acceptance gates pass before deployment.
