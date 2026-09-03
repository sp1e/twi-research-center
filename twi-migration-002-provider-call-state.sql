-- TWI provider-call state (migration 002).
--
-- One row per BILLABLE provider call, identified by (job_id, attempt, label). The row
-- is written BEFORE the call is made and settled immediately after it returns, so a
-- crash anywhere in between leaves a row that says exactly what is known: a paid call
-- may be in flight and its charge is unknown. That is what the research P0 asks for --
-- persist the submission claim, the provider request id and the charge certainty, and
-- never repeat an ambiguous paid call blindly.
--
-- 'not_submitted' is NEVER stored. It is the word a READER uses for the absence of a
-- row, and it means "no call was recorded", never "not charged". That reading is sound
-- ONLY because the claim row precedes the call: absence can then only mean the call was
-- never attempted, which is why the two facts are always documented together.
--
-- States, and what each says about the money:
--
--   submitting   the claim is written, the provider may or may not have been called  unknown
--   completed    the provider returned audio and a request id                        charged
--   accepted     the provider certainly entered the money path but returned nothing  charged
--                usable (ProviderError.charged is true)
--   ambiguous    the adapter cannot say whether the money path was entered           unknown
--                (ProviderError.charged is null)
--   abandoned    the adapter PROVED the money path was never entered                 not_charged
--                (ProviderError.charged is false), or a human resolved it so
--
-- charge_certainty is a separate column rather than something a reader derives from the
-- state, so the retry gate and the reconciliation inventory can read it directly. The
-- table-level CHECK twi_provider_calls_state_certainty makes the five pairs above the ONLY
-- representable rows.
--
-- Be precise about what that does and does not buy, because the first draft of this header
-- overstated it. The CHECK constrains ONE ROW'S PAIR. It is not a transition rule: a single
-- UPDATE that moves state and charge_certainty TOGETHER lands a legal pair, so raw SQL can
-- still walk a row from one legal pair to another. What refuses a TRANSITION is the
-- repository's guarded WHERE clauses (settle matches only state = 'submitting', resolve only
-- the state the caller read and resolved_at IS NULL) -- and a writer with direct database
-- access is outside that guarantee. Two things narrow the gap inside the schema itself:
-- twi_provider_calls_abandoned_has_no_request_id, which refuses the one laundering shape that
-- was reachable in a single statement (completed/charged -> abandoned/not_charged while the
-- request id of the denied charge is still on the row), and twi_provider_calls_settled_iff_not_submitting,
-- which refuses a row that left submitting without saying when.
--
-- Two of the rows are settled by a human rather than by code: an ambiguous or still
-- submitting call is RESOLVED to accepted or abandoned, with resolved_at and a nonblank
-- resolution_note written together. Rows that are neither not_charged nor resolved are
-- what the retry gate refuses to retry past and what the inventory counts.
--
-- Same conventions as migration 001: every CHECK is named, identity columns are guarded
-- on storage class and emptiness, timestamps are the three-conjunct
-- strftime round-trip including the hour-24 clause, JSON columns require an object,
-- every statement is IF NOT EXISTS, and no comment contains a semicolon because the D1
-- boot path in src/twi/server/repository-d1.test.ts splits this file on the statement
-- terminator.

CREATE TABLE IF NOT EXISTS twi_provider_calls (
  job_id TEXT NOT NULL REFERENCES twi_jobs(id) ON DELETE CASCADE,
  -- What this CHECK actually refuses, measured rather than assumed: non-numeric text, a REAL,
  -- a BLOB and a negative. It does NOT refuse the STRING '0' or '1' -- INTEGER affinity converts
  -- a numeric string to an integer BEFORE any CHECK runs, so typeof() already sees 'integer'.
  -- The boundary is what refuses a string attempt (provider-calls.ts requires a nonnegative safe
  -- integer before anything is bound) -- this is the second line, and it is narrower than the
  -- first draft of this comment claimed.
  attempt INTEGER NOT NULL
    CONSTRAINT twi_provider_calls_attempt_integer CHECK (typeof(attempt) = 'integer' AND attempt >= 0),
  label TEXT NOT NULL
    CONSTRAINT twi_provider_calls_label_enum CHECK (label IN ('A','B')),
  claim_key TEXT NOT NULL
    CONSTRAINT twi_provider_calls_claim_key_identity CHECK (typeof(claim_key) = 'text' AND length(claim_key) > 0),
  state TEXT NOT NULL
    CONSTRAINT twi_provider_calls_state_enum CHECK (state IN ('submitting','accepted','completed','ambiguous','abandoned')),
  charge_certainty TEXT NOT NULL
    CONSTRAINT twi_provider_calls_charge_certainty_enum CHECK (charge_certainty IN ('unknown','charged','not_charged')),
  provider_mode TEXT NOT NULL
    CONSTRAINT twi_provider_calls_provider_mode_identity CHECK (typeof(provider_mode) = 'text' AND length(provider_mode) > 0),
  provider TEXT,
  model TEXT,
  provider_request_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
    CONSTRAINT twi_provider_calls_detail_json_object
    CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  claimed_at TEXT NOT NULL
    CONSTRAINT twi_provider_calls_claimed_at_iso CHECK (
      typeof(claimed_at) = 'text'
      AND claimed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at)
      AND substr(claimed_at, 12, 2) <> '24'
    ),
  settled_at TEXT
    CONSTRAINT twi_provider_calls_settled_at_iso CHECK (
      settled_at IS NULL
      OR (
        typeof(settled_at) = 'text'
        AND settled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', settled_at)
        AND substr(settled_at, 12, 2) <> '24'
      )
    ),
  resolved_at TEXT
    CONSTRAINT twi_provider_calls_resolved_at_iso CHECK (
      resolved_at IS NULL
      OR (
        typeof(resolved_at) = 'text'
        AND resolved_at IS strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at)
        AND substr(resolved_at, 12, 2) <> '24'
      )
    ),
  resolution_note TEXT,
  -- The identity of one billable call, and what makes the claim insert idempotent under
  -- ON CONFLICT DO NOTHING: a re-executed step body finds its own row and is refused.
  PRIMARY KEY (job_id, attempt, label),
  UNIQUE (job_id, claim_key),
  CONSTRAINT twi_provider_calls_state_certainty CHECK (
    (state = 'submitting' AND charge_certainty = 'unknown')
    OR (state = 'ambiguous' AND charge_certainty = 'unknown')
    OR (state = 'completed' AND charge_certainty = 'charged')
    OR (state = 'accepted' AND charge_certainty = 'charged')
    OR (state = 'abandoned' AND charge_certainty = 'not_charged')
  ),
  -- The P0 says persist the request id. A completed call without one is unreconcilable:
  -- a charge on the account with nothing in the database to match it against.
  -- BLANK means blank. SQLite's one-argument trim() strips SPACES only, so a tab-or-newline
  -- request id would pass length(trim(x)) > 0 while the repository boundary's JS .trim() refuses
  -- it -- the schema must be the stricter of the two, never the looser. The character set is
  -- space, tab, LF, CR, spelled with char() because no comment or literal here may hold a
  -- control byte.
  CONSTRAINT twi_provider_calls_completed_has_request_id CHECK (
    state <> 'completed'
    OR (
      typeof(provider_request_id) = 'text'
      AND length(trim(provider_request_id, ' ' || char(9) || char(10) || char(13))) > 0
    )
  ),
  -- The mirror of the rule above, and the only thing standing in front of a LAUNDERING UPDATE.
  -- The state/certainty CHECK constrains one row's PAIR, not a transition, so a single statement
  -- that moves both columns at once turns a completed/charged call into not_charged while it
  -- still carries the request id of the charge it now denies -- and the row stops blocking a
  -- retry. "Never charged" and "here is the charge's id" cannot both be true.
  CONSTRAINT twi_provider_calls_abandoned_has_no_request_id CHECK (
    state <> 'abandoned' OR provider_request_id IS NULL
  ),
  CONSTRAINT twi_provider_calls_settled_iff_not_submitting CHECK (
    (state = 'submitting' AND settled_at IS NULL)
    OR (state <> 'submitting' AND settled_at IS NOT NULL)
  ),
  CONSTRAINT twi_provider_calls_settled_not_before_claimed CHECK (
    settled_at IS NULL OR settled_at >= claimed_at
  ),
  CONSTRAINT twi_provider_calls_resolution_pair CHECK (
    (resolved_at IS NULL AND resolution_note IS NULL)
    OR (
      resolved_at IS NOT NULL
      AND typeof(resolution_note) = 'text'
      -- The same whitespace set as the request-id CHECK above, and for the same reason: a
      -- tab-only note is not a reconciliation record.
      AND length(trim(resolution_note, ' ' || char(9) || char(10) || char(13))) > 0
    )
  ),
  CONSTRAINT twi_provider_calls_resolved_not_before_claimed CHECK (
    resolved_at IS NULL OR resolved_at >= claimed_at
  )
);

-- The retry gate reads every call of ONE job, in (attempt, label) order. This duplicates
-- the primary key's automatic index on purpose: the automatic index has no stable name,
-- so nothing could pin the read to it, and the planner prefers the named index when both
-- exist (measured with EXPLAIN QUERY PLAN in scripts/twi-schema-behavior.test.mjs).
CREATE INDEX IF NOT EXISTS idx_twi_provider_calls_job ON twi_provider_calls(job_id, attempt, label);

-- The reconciliation inventory: every call, across all jobs, whose charge is not known
-- to be absent and that no human has resolved. A PARTIAL index, so it holds exactly the
-- rows the estate-wide count and the per-job gate ask about and nothing else.
--
-- SQLite's actual rule is that the index's WHERE clause must be IMPLIED BY the query's, not
-- spelled identically -- measured: widening this predicate to `WHERE resolved_at IS NULL`
-- leaves both plans unchanged. The two are nevertheless kept spelled byte for byte, because
-- NARROWING it past what the query implies silently degrades the inventory read to a full table
-- scan, and a spelling that must match is the cheapest thing to keep true. The exact text is
-- pinned from sqlite_master in scripts/twi-schema-provider-calls.test.mjs.
CREATE INDEX IF NOT EXISTS idx_twi_provider_calls_unresolved ON twi_provider_calls(job_id, attempt, label)
  WHERE charge_certainty <> 'not_charged' AND resolved_at IS NULL;
