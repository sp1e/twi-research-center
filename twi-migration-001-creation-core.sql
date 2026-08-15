CREATE TABLE IF NOT EXISTS twi_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_revision_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','deleted')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (lifecycle_state = 'active' AND deleted_at IS NULL)
    OR (lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
  ),
  FOREIGN KEY (id, current_revision_id)
    REFERENCES twi_project_revisions(project_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS twi_project_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES twi_project_revisions(id),
  snapshot_key TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  CHECK (parent_revision_id IS NULL OR parent_revision_id <> id),
  FOREIGN KEY (project_id, parent_revision_id)
    REFERENCES twi_project_revisions(project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_generation_specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  spec_sha256 TEXT NOT NULL,
  rights_assertion_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full-song','finish')),
  status TEXT NOT NULL CHECK (status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  phase TEXT,
  workflow_id TEXT,
  provider TEXT,
  model TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  estimate_json TEXT CHECK (estimate_json IS NULL OR json_valid(estimate_json)),
  actual_cost_usd REAL NOT NULL DEFAULT 0 CHECK (
    typeof(actual_cost_usd) IN ('integer','real')
    AND actual_cost_usd >= 0
    AND actual_cost_usd < 1.0e308
  ),
  output_manifest_json TEXT CHECK (output_manifest_json IS NULL OR json_valid(output_manifest_json)),
  retry_checkpoint TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, spec_id)
    REFERENCES twi_generation_specs(project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  to_status TEXT NOT NULL CHECK (to_status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  phase TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, event_key)
);

CREATE TABLE IF NOT EXISTS twi_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('image-reference','generation-raw','generation-master','generation-preview','provenance')),
  label TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes >= 0),
  duration_seconds REAL CHECK (
    duration_seconds IS NULL
    OR (
      typeof(duration_seconds) IN ('integer','real')
      AND duration_seconds >= 0
      AND duration_seconds < 1.0e308
    )
  ),
  sha256 TEXT NOT NULL,
  provenance_key TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('provisional','active','hidden','deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
    OR (lifecycle_state IN ('provisional','active','hidden') AND deleted_at IS NULL)
  ),
  FOREIGN KEY (project_id, job_id)
    REFERENCES twi_jobs(project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('estimate','provider','finishing','storage')),
  provider TEXT,
  model TEXT,
  amount_usd REAL NOT NULL CHECK (
    typeof(amount_usd) IN ('integer','real')
    AND amount_usd >= 0
    AND amount_usd < 1.0e308
  ),
  quantity REAL CHECK (
    quantity IS NULL
    OR (
      typeof(quantity) IN ('integer','real')
      AND quantity >= 0
      AND quantity < 1.0e308
    )
  ),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_twi_projects_updated ON twi_projects(lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_revisions_project ON twi_project_revisions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_revisions_parent ON twi_project_revisions(project_id, parent_revision_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_jobs_project ON twi_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_jobs_status ON twi_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_twi_job_events_job ON twi_job_events(job_id, id);
CREATE INDEX IF NOT EXISTS idx_twi_assets_project ON twi_assets(project_id, lifecycle_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_assets_job ON twi_assets(job_id, lifecycle_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twi_cost_events_job ON twi_cost_events(job_id, id);
