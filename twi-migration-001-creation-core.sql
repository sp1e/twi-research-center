-- TWI Creation Core.
--
-- Conventions this file holds to, because SQLite is dynamically typed and a
-- declared column type guarantees nothing on its own.
--
--   * Every CHECK is named, so a rejection reports which rule fired rather than
--     a wall of expression text.
--   * Identity columns are guarded on storage class AND emptiness, with
--     typeof(x) = 'text' AND length(x) > 0.
--   * Numeric columns are guarded on storage class, sign, and a finite upper
--     bound. The bound is what rejects Infinity and is load-bearing, so do not
--     "simplify" it away.
--   * Timestamps are fixed-width ISO-8601 UTC milliseconds
--     (YYYY-MM-DDTHH:MM:SS.sssZ), matching what the repository layer validates
--     at its boundary. The repository advances updated_at with
--     MAX(updated_at, ?), a BINARY comparison over TEXT, so one differently
--     shaped timestamp would latch the column against every later correct one.
--     The guard is a strftime round-trip rather than a GLOB, for two measured
--     reasons. GLOB has no single-character wildcard (that is LIKE), so the
--     obvious '____-__-__T__:__:__.___Z' matches nothing at all. And D1 caps
--     LIKE/GLOB patterns at 50 characters, so a digit-class pattern long enough
--     to be strict fails at write time with "LIKE or GLOB pattern too complex"
--     even though node:sqlite accepts it happily. The round-trip is shorter and
--     also rejects impossible calendar dates such as month 13.
--   * JSON columns use json_type(x) = 'object', not json_valid(x) alone.
--     json_valid() happily accepts 123, null, "hello" and [].
--
-- Two mechanical rules. Every statement is IF NOT EXISTS, because the migration
-- runner applies and records in two separate wrangler calls and a partial re-run
-- must be safe. And no comment may contain a semicolon, because the D1 boot path
-- in src/twi/server/repository-d1.test.ts splits this file on the statement
-- terminator and a comment-only chunk fails there with the D1 error "SQL code
-- did not contain a statement".

CREATE TABLE IF NOT EXISTS twi_projects (
  id TEXT PRIMARY KEY
    CONSTRAINT twi_projects_id_identity CHECK (typeof(id) = 'text' AND length(id) > 0),
  name TEXT NOT NULL
    CONSTRAINT twi_projects_name_text CHECK (typeof(name) = 'text' AND length(trim(name)) > 0),
  current_revision_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT twi_projects_lifecycle_enum CHECK (lifecycle_state IN ('active','deleted')),
  deleted_at TEXT
    CONSTRAINT twi_projects_deleted_at_iso CHECK (
      deleted_at IS NULL
      OR (
        typeof(deleted_at) = 'text' AND deleted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)
      )
    ),
  created_at TEXT NOT NULL
    CONSTRAINT twi_projects_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
  updated_at TEXT NOT NULL
    CONSTRAINT twi_projects_updated_at_iso CHECK (
      typeof(updated_at) = 'text' AND updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
    ),
  CONSTRAINT twi_projects_lifecycle_deleted_at CHECK (
    (lifecycle_state = 'active' AND deleted_at IS NULL)
    OR (lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT twi_projects_updated_not_before_created CHECK (updated_at >= created_at),
  FOREIGN KEY (id, current_revision_id)
    REFERENCES twi_project_revisions(project_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS twi_project_revisions (
  id TEXT PRIMARY KEY
    CONSTRAINT twi_project_revisions_id_identity CHECK (typeof(id) = 'text' AND length(id) > 0),
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES twi_project_revisions(id),
  snapshot_key TEXT NOT NULL
    CONSTRAINT twi_project_revisions_snapshot_key_identity
    CHECK (typeof(snapshot_key) = 'text' AND length(snapshot_key) > 0),
  snapshot_sha256 TEXT NOT NULL
    CONSTRAINT twi_project_revisions_snapshot_sha256_identity
    CHECK (typeof(snapshot_sha256) = 'text' AND length(snapshot_sha256) > 0),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
    CONSTRAINT twi_project_revisions_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
  UNIQUE (project_id, id),
  CONSTRAINT twi_project_revisions_parent_not_self
    CHECK (parent_revision_id IS NULL OR parent_revision_id <> id),
  FOREIGN KEY (project_id, parent_revision_id)
    REFERENCES twi_project_revisions(project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_generation_specs (
  id TEXT PRIMARY KEY
    CONSTRAINT twi_generation_specs_id_identity CHECK (typeof(id) = 'text' AND length(id) > 0),
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  spec_json TEXT NOT NULL
    CONSTRAINT twi_generation_specs_spec_json_object
    CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  spec_sha256 TEXT NOT NULL
    CONSTRAINT twi_generation_specs_spec_sha256_identity
    CHECK (typeof(spec_sha256) = 'text' AND length(spec_sha256) > 0),
  rights_assertion_version TEXT NOT NULL
    CONSTRAINT twi_generation_specs_rights_version_identity
    CHECK (typeof(rights_assertion_version) = 'text' AND length(rights_assertion_version) > 0),
  created_at TEXT NOT NULL
    CONSTRAINT twi_generation_specs_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_jobs (
  id TEXT PRIMARY KEY
    CONSTRAINT twi_jobs_id_identity CHECK (typeof(id) = 'text' AND length(id) > 0),
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CONSTRAINT twi_jobs_kind_enum CHECK (kind IN ('full-song','finish')),
  status TEXT NOT NULL
    CONSTRAINT twi_jobs_status_enum CHECK (status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  -- JobPhase = Exclude<JobStatus,'draft'|'estimated'> (src/twi/domain/types.ts:2).
  phase TEXT
    CONSTRAINT twi_jobs_phase_enum CHECK (phase IS NULL OR phase IN ('queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  workflow_id TEXT,
  provider TEXT,
  model TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
    CONSTRAINT twi_jobs_idempotency_key_identity
    CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) > 0),
  estimate_json TEXT
    CONSTRAINT twi_jobs_estimate_json_object
    CHECK (estimate_json IS NULL OR (json_valid(estimate_json) AND json_type(estimate_json) = 'object')),
  actual_cost_usd REAL NOT NULL DEFAULT 0
    CONSTRAINT twi_jobs_actual_cost_usd_finite CHECK (
      typeof(actual_cost_usd) IN ('integer','real')
      AND actual_cost_usd >= 0
      AND actual_cost_usd < 1.0e308
    ),
  output_manifest_json TEXT
    CONSTRAINT twi_jobs_output_manifest_json_object
    CHECK (
      output_manifest_json IS NULL
      OR (json_valid(output_manifest_json) AND json_type(output_manifest_json) = 'object')
    ),
  retry_checkpoint TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
    CONSTRAINT twi_jobs_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
  updated_at TEXT NOT NULL
    CONSTRAINT twi_jobs_updated_at_iso CHECK (
      typeof(updated_at) = 'text' AND updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
    ),
  finished_at TEXT
    CONSTRAINT twi_jobs_finished_at_iso CHECK (
      finished_at IS NULL
      OR (
        typeof(finished_at) = 'text' AND finished_at IS strftime('%Y-%m-%dT%H:%M:%fZ', finished_at)
      )
    ),
  UNIQUE (project_id, id),
  -- Satisfied by the repository's monotonic `updated_at = MAX(updated_at, ?)`:
  -- MAX() can only hold or advance a column that already passed this guard.
  CONSTRAINT twi_jobs_updated_not_before_created CHECK (updated_at >= created_at),
  FOREIGN KEY (project_id, spec_id)
    REFERENCES twi_generation_specs(project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL
    CONSTRAINT twi_job_events_event_key_identity
    CHECK (typeof(event_key) = 'text' AND length(event_key) > 0),
  from_status TEXT
    CONSTRAINT twi_job_events_from_status_enum CHECK (from_status IS NULL OR from_status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  to_status TEXT NOT NULL
    CONSTRAINT twi_job_events_to_status_enum CHECK (to_status IN ('draft','estimated','queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  phase TEXT
    CONSTRAINT twi_job_events_phase_enum CHECK (phase IS NULL OR phase IN ('queued','generating','ingesting','finishing','validating','complete','cancelling','cancelled','error','retrying')),
  detail_json TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT twi_job_events_detail_json_object
    CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  created_at TEXT NOT NULL
    CONSTRAINT twi_job_events_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
  UNIQUE (job_id, event_key)
);

CREATE TABLE IF NOT EXISTS twi_assets (
  id TEXT PRIMARY KEY
    CONSTRAINT twi_assets_id_identity CHECK (typeof(id) = 'text' AND length(id) > 0),
  project_id TEXT NOT NULL REFERENCES twi_projects(id) ON DELETE CASCADE,
  job_id TEXT,
  kind TEXT NOT NULL
    CONSTRAINT twi_assets_kind_enum CHECK (kind IN ('image-reference','generation-raw','generation-master','generation-preview','provenance')),
  label TEXT,
  r2_key TEXT NOT NULL UNIQUE
    CONSTRAINT twi_assets_r2_key_identity CHECK (typeof(r2_key) = 'text' AND length(r2_key) > 0),
  content_type TEXT NOT NULL
    CONSTRAINT twi_assets_content_type_identity
    CHECK (typeof(content_type) = 'text' AND length(content_type) > 0),
  bytes INTEGER NOT NULL
    CONSTRAINT twi_assets_bytes_integer CHECK (typeof(bytes) = 'integer' AND bytes >= 0),
  duration_seconds REAL
    CONSTRAINT twi_assets_duration_seconds_finite CHECK (
      duration_seconds IS NULL
      OR (
        typeof(duration_seconds) IN ('integer','real')
        AND duration_seconds >= 0
        AND duration_seconds < 1.0e308
      )
    ),
  sha256 TEXT NOT NULL
    CONSTRAINT twi_assets_sha256_identity CHECK (typeof(sha256) = 'text' AND length(sha256) > 0),
  provenance_key TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT twi_assets_lifecycle_enum CHECK (lifecycle_state IN ('provisional','active','hidden','deleted')),
  created_at TEXT NOT NULL
    CONSTRAINT twi_assets_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
  deleted_at TEXT
    CONSTRAINT twi_assets_deleted_at_iso CHECK (
      deleted_at IS NULL
      OR (
        typeof(deleted_at) = 'text' AND deleted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)
      )
    ),
  CONSTRAINT twi_assets_lifecycle_deleted_at CHECK (
    (lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
    OR (lifecycle_state IN ('provisional','active','hidden') AND deleted_at IS NULL)
  ),
  FOREIGN KEY (project_id, job_id)
    REFERENCES twi_jobs(project_id, id)
);

CREATE TABLE IF NOT EXISTS twi_cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL
    CONSTRAINT twi_cost_events_idempotency_key_identity
    CHECK (typeof(idempotency_key) = 'text' AND length(idempotency_key) > 0),
  category TEXT NOT NULL
    CONSTRAINT twi_cost_events_category_enum CHECK (category IN ('estimate','provider','finishing','storage')),
  provider TEXT,
  model TEXT,
  amount_usd REAL NOT NULL
    CONSTRAINT twi_cost_events_amount_usd_finite CHECK (
      typeof(amount_usd) IN ('integer','real')
      AND amount_usd >= 0
      AND amount_usd < 1.0e308
    ),
  quantity REAL
    CONSTRAINT twi_cost_events_quantity_finite CHECK (
      quantity IS NULL
      OR (
        typeof(quantity) IN ('integer','real')
        AND quantity >= 0
        AND quantity < 1.0e308
      )
    ),
  detail_json TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT twi_cost_events_detail_json_object
    CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  created_at TEXT NOT NULL
    CONSTRAINT twi_cost_events_created_at_iso CHECK (
      typeof(created_at) = 'text' AND created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
    ),
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
