"""Provider-call state harness: the research P0 (never repeat an ambiguous paid call blindly).

The question this answers is the one a green suite cannot: does the suite DETECT a ledger that
has been weakened? Every guard the P0 landed as fires only on state the happy path never produces
-- a re-executed step body, a provider that failed with an unknown charge, a retry pressed after a
paid attempt -- which is exactly the shape that let nine of twelve publication mutants survive a
green suite once before on this project.

Five groups:

  PCS-01/02/19   THE SCHEMA IS THE SECOND LINE OF DEFENCE. The state/certainty pairing CHECK
                 deleted, widened to admit ambiguous/not_charged, and the completed-needs-request-id
                 CHECK deleted. Each must die in the schema suite, which drives the table with RAW
                 SQL because TypeScript can never produce an illegal pair.
  PCS-03/04/08   THE CLAIM IS IDEMPOTENT AND THE SETTLEMENT HAPPENS ONCE. DO NOTHING turned into DO
  PCS-12/13      UPDATE, the changes() read replaced by a constant, the settle guard dropped, a blank
                 resolution note accepted, a resolution that leaves a submitting row submitting.
  PCS-05/06/07   THE STEP BODY'S ORDER. The already-claimed refusal deleted (the provider is then
  PCS-18/20      called), the claim moved AFTER the provider call, charged null mapped to abandoned,
                 charged true mapped to ambiguous, the settlement moved after the R2 put.
  PCS-09/10/11   THE RETRY GATE. Deleted, narrowed to ambiguous only (a completed call stops
                 blocking), moved after the retrying transition.
  PCS-14/15      THE CALL, NOT THE PREDICATE. PCS-14 keeps runGenerateStep's behaviour byte for
                 byte but invokes it through an alias, so the Workflow's call graph no longer names
                 it: every test stays green and ONLY the contract check dies. That is the T13
                 lesson measured again. PCS-15 inlines the pre-P0 body (no claim, no settle) and
                 dies in the integration suite as well.
  PCS-16/17      THE THREE CONSUMERS THAT HARD-CODE THE MIGRATION SET. Migration 002 dropped from
                 the repository harness (a repository test must go red) and from the orchestrator's
                 vitest config (the integration suite must go red).
  PCS-21 to 26   ADDED IN FIX ROUND 1, five of them because a verifier's own hand mutant SURVIVED
                 this harness's first campaign and one because the round added a guard. PCS-21 is
                 the worst of them: the step READ the settlement outcome without comparing it, so
                 narrowing the comparison left 184/184 green while paid audio was published against
                 a row saying the money was never spent. PCS-22 is the adapter's 4xx catch-all
                 answering charged:false for a 408 or a 499 -- the one verdict that lets a retry
                 buy a second render with no human consulted. PCS-23 is the half of resolve's WHERE
                 clause its sibling state guard was hiding. PCS-24/25 are the schema's two
                 whitespace/laundering holes, and PCS-26 widens the partial index, which no
                 EXPLAIN QUERY PLAN assertion can see -- only the pinned index text can.

    python docs/superpowers/mutants/harnesses/provider_call_state_mutants.py

Each mutation is applied to ONE file, verified to have LANDED (a needle that no longer matches is
reported as NEEDLE-MISSING, never as a kill), run against the suite or suites that should kill it
-- named per mutant, because they answer different questions -- and restored byte-identically
against a recorded sha256 inside finally. A mutation that fails to apply is indistinguishable from
one that got killed, and this project has been fooled that way three times. Files are read and
written as BYTES so the repository's LF endings survive a Windows host.

The killing test names are extracted from each runner's own output (vitest's `x` lines, node:test's
`✖` lines, the contract check's `FAIL` lines) and printed as JSON at the end, so they can be read
back into the manifest rather than retyped.
"""
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
PKG = ROOT / "twi-orchestrator"
MIGRATION = ROOT / "twi-migration-002-provider-call-state.sql"
QUERIES = ROOT / "src" / "twi" / "server" / "queries-provider-calls.ts"
LEDGER = ROOT / "src" / "twi" / "server" / "provider-calls.ts"
RETRY = ROOT / "src" / "twi" / "server" / "jobs-cancel-retry.ts"
HARNESS = ROOT / "src" / "twi" / "server" / "repository.harness.ts"
STEP = PKG / "src" / "generate-step.ts"
WORKFLOW = PKG / "src" / "workflow.ts"
VITEST_CONFIG = PKG / "vitest.config.ts"
LYRIA = PKG / "src" / "providers" / "lyria.ts"

SCHEMA = "npm run test:twi:schema"
SERVER = "npx vitest run --config vitest.twi.config.ts src/twi/server"
ORCHESTRATOR = "npm test --prefix twi-orchestrator"
CONTRACTS = "npm run test:twi:contracts"

NL = chr(10)

STATE_CERTAINTY_CHECK = (
    "  CONSTRAINT twi_provider_calls_state_certainty CHECK (" + NL
    + "    (state = 'submitting' AND charge_certainty = 'unknown')" + NL
    + "    OR (state = 'ambiguous' AND charge_certainty = 'unknown')" + NL
    + "    OR (state = 'completed' AND charge_certainty = 'charged')" + NL
    + "    OR (state = 'accepted' AND charge_certainty = 'charged')" + NL
    + "    OR (state = 'abandoned' AND charge_certainty = 'not_charged')" + NL
    + "  )," + NL
)
TRIMMED_REQUEST_ID = (
    "      AND length(trim(provider_request_id, ' ' || char(9) || char(10) || char(13))) > 0" + NL
)
UNTRIMMED_REQUEST_ID = (
    "      AND length(provider_request_id) > 0" + NL
)
REQUEST_ID_CHECK = (
    "  CONSTRAINT twi_provider_calls_completed_has_request_id CHECK (" + NL
    + "    state <> 'completed'" + NL
    + "    OR (" + NL
    + "      typeof(provider_request_id) = 'text'" + NL
    + TRIMMED_REQUEST_ID
    + "    )" + NL
    + "  )," + NL
)
ABANDONED_CHECK = (
    "  CONSTRAINT twi_provider_calls_abandoned_has_no_request_id CHECK (" + NL
    + "    state <> 'abandoned' OR provider_request_id IS NULL" + NL
    + "  )," + NL
)
UNRESOLVED_INDEX_PREDICATE = (
    "  WHERE charge_certainty <> 'not_charged' AND resolved_at IS NULL;" + NL
)
SETTLEMENT_OUTCOME_GUARD = "  if (settled.outcome !== 'settled') {" + NL
SETTLEMENT_OUTCOME_NARROWED = "  if (settled.outcome === 'not-claimed') {" + NL
RESOLVE_GUARD = (
    "       WHERE job_id = ? AND attempt = ? AND label = ? AND state = ? AND resolved_at IS NULL`," + NL
)
RESOLVE_GUARD_NARROWED = (
    "       WHERE job_id = ? AND attempt = ? AND label = ? AND state = ?`," + NL
)
HTTP_CATCH_ALL = (
    "  return new ProviderError('provider_unavailable', 'the provider did not answer this request conclusively', null);" + NL
)
HTTP_CATCH_ALL_NOT_CHARGED = (
    "  return new ProviderError('provider_rejected', 'the provider rejected this request', false);" + NL
    + "  // the pre-P0 catch-all: every status below 500 declared unpaid" + NL
)
CLAIM_THEN_CALL = (
    "  const claim = await store.claimProviderCall({" + NL
    + "    ...identity," + NL
    + "    providerMode," + NL
    + "    now," + NL
    + "    detailJson: JSON.stringify({ schemaVersion: 1, projectId: payload.projectId })," + NL
    + "  });" + NL
    + "  if (claim.outcome === 'already-claimed') throw nonRetryable(PROVIDER_CALL_ALREADY_CLAIMED);" + NL
    + NL
    + "  // 2. The billable call." + NL
    + "  let candidate: ProviderCandidate;" + NL
    + "  try {" + NL
    + "    candidate = await provider.generate(spec, label);" + NL
)
CALL_THEN_CLAIM = (
    "  const early: ProviderCandidate = await provider.generate(spec, label);" + NL
    + "  const claim = await store.claimProviderCall({" + NL
    + "    ...identity," + NL
    + "    providerMode," + NL
    + "    now," + NL
    + "    detailJson: JSON.stringify({ schemaVersion: 1, projectId: payload.projectId })," + NL
    + "  });" + NL
    + "  if (claim.outcome === 'already-claimed') throw nonRetryable(PROVIDER_CALL_ALREADY_CLAIMED);" + NL
    + NL
    + "  let candidate: ProviderCandidate;" + NL
    + "  try {" + NL
    + "    candidate = early;" + NL
)
SETTLE_BLOCK = (
    "  const settled = await store.settleProviderCall({" + NL
    + "    ...identity," + NL
    + "    state: 'completed'," + NL
    + "    providerRequestId: candidate.providerRequestId," + NL
    + "    provider: candidate.provider," + NL
    + "    model: candidate.model," + NL
    + "    now," + NL
    + "  });" + NL
    + "  if (settled.outcome !== 'settled') {" + NL
    + "    throw new Error(`provider call settlement was ${settled.outcome}, so the candidate cannot be recorded against its charge`);" + NL
    + "  }" + NL
    + NL
)
PUT_BLOCK = (
    "  await files.put(key, candidate.bytes, {" + NL
    + "    httpMetadata: { contentType: candidate.contentType }," + NL
    + "    customMetadata: {" + NL
    + "      provider: candidate.provider," + NL
    + "      model: candidate.model," + NL
    + "      providerRequestId: candidate.providerRequestId," + NL
    + "    }," + NL
    + "  });" + NL
)
KEYS_BLOCK = (
    "  const prefix = objectPrefix(payload, label);" + NL
    + "  const key = `${prefix}/raw.wav`;" + NL
    + "  const provenanceKey = `${prefix}/provenance.json`;" + NL
    + "  const sha256 = await sha256Hex(candidate.bytes);" + NL
)
GATE = (
    "  // THE PROVIDER-CALL GATE. Read before the ordinal, before any write." + NL
    + "  const blocking = (await deps.repo.listProviderCalls(job.id)).find(isUnreconciledProviderCall);" + NL
    + "  if (blocking) {" + NL
    + "    throw new HttpError(" + NL
    + "      409," + NL
    + "      `attempt ${blocking.attempt} candidate ${blocking.label} left a provider call in state ${blocking.state} ` +" + NL
    + "        `with charge certainty ${blocking.chargeCertainty}; a retry would pay for both candidates again, ` +" + NL
    + "        'so the call must be resolved first'," + NL
    + "      'unreconciled_provider_call'," + NL
    + "    );" + NL
    + "  }" + NL
    + NL
)
ORDINAL_AND_TRANSITION = (
    "  const clock = clockOf(deps);" + NL
    + "  // The ordinal comes from the job's own history, so it advances across retries even" + NL
    + "  // across isolates. Attempt 0 is the submission, so the first retry is 1." + NL
    + "  const attempt = (await deps.repo.countJobEvents({ jobId: job.id, toStatus: 'retrying' })) + 1;" + NL
    + NL
    + "  const retrying = await deps.repo.transitionJob(job.id, 'retrying', {" + NL
    + "    fromStatus: 'error'," + NL
    + "    phase: 'retrying'," + NL
    + "    retryCheckpoint: job.retryCheckpoint ?? DEFAULT_RETRY_CHECKPOINT," + NL
    + "    now: clock.now()," + NL
    + "    eventKey: eventKey(job.id, attempt, 'retrying')," + NL
    + "    detailJson: JSON.stringify({ schemaVersion: 1, attempt, resumedFrom: job.retryCheckpoint })," + NL
    + "  });" + NL
)
RUN_GENERATE_CALL = (
    "        return runGenerateStep({" + NL
    + "          store," + NL
    + "          provider," + NL
    + "          providerMode: mode," + NL
    + "          payload," + NL
    + "          spec: loaded.spec," + NL
    + "          label," + NL
    + "          files: this.env.FILES," + NL
    + "          now," + NL
    + "        });" + NL
)
ALIASED_CALL = (
    "        const body = runGenerateStep;" + NL
    + "        return body({" + NL
    + "          store," + NL
    + "          provider," + NL
    + "          providerMode: mode," + NL
    + "          payload," + NL
    + "          spec: loaded.spec," + NL
    + "          label," + NL
    + "          files: this.env.FILES," + NL
    + "          now," + NL
    + "        });" + NL
)
PRE_P0_BODY = (
    "        const candidate = await provider.generate(loaded.spec, label);" + NL
    + "        const prefix = objectPrefix(payload, label);" + NL
    + "        const key = `${prefix}/raw.wav`;" + NL
    + "        const provenanceKey = `${prefix}/provenance.json`;" + NL
    + "        const sha256 = await sha256Hex(candidate.bytes);" + NL
    + "        await this.env.FILES.put(key, candidate.bytes, {" + NL
    + "          httpMetadata: { contentType: candidate.contentType }," + NL
    + "          customMetadata: { provider: candidate.provider, model: candidate.model, providerRequestId: candidate.providerRequestId }," + NL
    + "        });" + NL
    + "        void mode;" + NL
    + "        return {" + NL
    + "          id: assetId(payload, label, 'raw')," + NL
    + "          key," + NL
    + "          contentType: candidate.contentType," + NL
    + "          sizeBytes: candidate.bytes.byteLength," + NL
    + "          sha256," + NL
    + "          durationSeconds: candidate.durationSeconds," + NL
    + "          label," + NL
    + "          provider: candidate.provider," + NL
    + "          model: candidate.model," + NL
    + "          providerCostUsd: candidate.providerCostUsd," + NL
    + "          providerRequestId: candidate.providerRequestId," + NL
    + "          provenanceKey," + NL
    + "        };" + NL
)

# (id, label, file, find, replace, [commands that should kill it])
M = [
    ("PCS-01", "state/certainty pairing CHECK deleted", MIGRATION, STATE_CERTAINTY_CHECK, "", [SCHEMA]),
    ("PCS-02", "pairing CHECK widened: ambiguous may read not_charged", MIGRATION,
     "    OR (state = 'ambiguous' AND charge_certainty = 'unknown')" + NL,
     "    OR (state = 'ambiguous' AND charge_certainty IN ('unknown','not_charged'))" + NL, [SCHEMA]),
    ("PCS-03", "claim's DO NOTHING turned into DO UPDATE", QUERIES,
     "       ON CONFLICT(job_id, attempt, label) DO NOTHING`,",
     "       ON CONFLICT(job_id, attempt, label) DO UPDATE SET claimed_at = excluded.claimed_at`,", [SERVER]),
    ("PCS-04", "claim's changes() read replaced by a constant", LEDGER,
     "  if (changes === 1) {" + NL, "  if (true) {" + NL, [SERVER]),
    ("PCS-05", "already-claimed refusal deleted: the provider is called", STEP,
     "  if (claim.outcome === 'already-claimed') throw nonRetryable(PROVIDER_CALL_ALREADY_CLAIMED);" + NL, "",
     [ORCHESTRATOR]),
    ("PCS-06", "claim moved AFTER the provider call", STEP, CLAIM_THEN_CALL, CALL_THEN_CLAIM, [ORCHESTRATOR]),
    ("PCS-07", "charged null settled as abandoned", STEP,
     "  return 'ambiguous';" + NL + "};", "  return 'abandoned';" + NL + "};", [ORCHESTRATOR]),
    ("PCS-08", "settle guard state = 'submitting' dropped", QUERIES,
     "       WHERE job_id = ? AND attempt = ? AND label = ? AND state = 'submitting'`,",
     "       WHERE job_id = ? AND attempt = ? AND label = ?`,", [SERVER]),
    ("PCS-09", "retry gate deleted", RETRY, GATE, "", [SERVER]),
    ("PCS-10", "retry gate narrowed to ambiguous only", RETRY,
     ".find(isUnreconciledProviderCall);", ".find((call) => call.state === 'ambiguous');", [SERVER]),
    ("PCS-11", "retry gate moved after the retrying transition", RETRY,
     GATE + ORDINAL_AND_TRANSITION, ORDINAL_AND_TRANSITION + GATE, [SERVER]),
    ("PCS-12", "resolve accepts a blank note", LEDGER,
     "  assertNonBlank('providerCall.note', input.note);" + NL, "", [SERVER]),
    ("PCS-13", "resolve leaves a submitting row submitting", LEDGER,
     "  const nextState: ProviderCallState = input.to ?? current.state;",
     "  const nextState: ProviderCallState = current.state;", [SERVER]),
    ("PCS-14", "runGenerateStep invoked through an alias: behaviour kept, call graph loses the name", WORKFLOW,
     RUN_GENERATE_CALL, ALIASED_CALL, [ORCHESTRATOR, CONTRACTS]),
    ("PCS-15", "the pre-P0 step body inlined: no claim, no settle", WORKFLOW,
     RUN_GENERATE_CALL, PRE_P0_BODY, [ORCHESTRATOR, CONTRACTS]),
    ("PCS-16", "migration 002 dropped from the repository harness", HARNESS,
     "  new URL('../../../twi-migration-002-provider-call-state.sql', import.meta.url)," + NL, "", [SERVER]),
    ("PCS-17", "migration 002 dropped from the orchestrator vitest config", VITEST_CONFIG,
     "const TWI_MIGRATIONS = ['twi-migration-001-creation-core.sql', 'twi-migration-002-provider-call-state.sql'];",
     "const TWI_MIGRATIONS = ['twi-migration-001-creation-core.sql'];", [ORCHESTRATOR]),
    ("PCS-18", "charged true settled as ambiguous", STEP,
     "  if (charged === true) return 'accepted';" + NL, "", [ORCHESTRATOR]),
    ("PCS-19", "completed-needs-request-id CHECK deleted", MIGRATION, REQUEST_ID_CHECK, "", [SCHEMA]),
    ("PCS-20", "settlement moved after the R2 put", STEP,
     SETTLE_BLOCK + KEYS_BLOCK + PUT_BLOCK, KEYS_BLOCK + PUT_BLOCK + SETTLE_BLOCK, [ORCHESTRATOR, CONTRACTS]),
    # --- fix round 1. Each of the five below is a guard a verifier's own hand mutant SURVIVED, or
    # --- a guard added in that round; PCS-21 and PCS-23 are the two survivors, reproduced here so
    # --- the committed harness measures them from now on.
    ("PCS-21", "the settlement outcome is read but not compared: 'already-settled' publishes anyway", STEP,
     SETTLEMENT_OUTCOME_GUARD, SETTLEMENT_OUTCOME_NARROWED, [ORCHESTRATOR, CONTRACTS]),
    ("PCS-22", "the 4xx catch-all reports every unrecognised status as PROVEN not charged", LYRIA,
     HTTP_CATCH_ALL, HTTP_CATCH_ALL_NOT_CHARGED, [ORCHESTRATOR]),
    ("PCS-23", "resolve's resolved_at IS NULL guard dropped: a landed resolution can be overwritten", QUERIES,
     RESOLVE_GUARD, RESOLVE_GUARD_NARROWED, [SERVER]),
    ("PCS-24", "the completed-request-id CHECK stops trimming: a whitespace request id is admitted", MIGRATION,
     TRIMMED_REQUEST_ID, UNTRIMMED_REQUEST_ID, [SCHEMA]),
    ("PCS-25", "the abandoned-has-no-request-id CHECK deleted: a charged row can be laundered in one UPDATE", MIGRATION,
     ABANDONED_CHECK, "", [SCHEMA]),
    ("PCS-26", "the unresolved partial index predicate WIDENED, which no plan assertion can see", MIGRATION,
     UNRESOLVED_INDEX_PREDICATE, "  WHERE resolved_at IS NULL;" + NL, [SCHEMA]),
]

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
VITEST_FAIL = re.compile(r"^\s*(?:×|x)\s+(.*?)(?:\s+\d+ms)?\s*$")
VITEST_FAIL_HEADER = re.compile(r"^\s*FAIL\s+(\S+\.test\.\w+ > .*)$")
NODE_FAIL = re.compile(r"^✖ (.*?) \(\d+(?:\.\d+)?ms\)$")
CONTRACT_FAIL = re.compile(r"^FAIL (.*)$")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def killers(output):
    """The failing test names a runner printed, in order, deduplicated."""
    seen = []
    for raw in ANSI.sub("", output).splitlines():
        line = raw.rstrip()
        for pattern in (VITEST_FAIL_HEADER, NODE_FAIL, CONTRACT_FAIL):
            match = pattern.match(line)
            if match:
                name = match.group(1).strip()
                if name and name not in seen and "failing tests" not in name:
                    seen.append(name)
                break
        else:
            match = VITEST_FAIL.match(line)
            if match and not line.strip().startswith("x "):
                name = match.group(1).strip()
                if name and name not in seen:
                    seen.append(name)
    return seen


def run(cmd):
    proc = subprocess.run(
        cmd, cwd=ROOT, shell=True, capture_output=True,
        text=True, encoding="utf-8", errors="replace",
    )
    return proc.returncode, killers(proc.stdout + NL + proc.stderr)


def main():
    rows = []
    for ident, label, target, find, repl, commands in M:
        original = target.read_bytes()
        text = original.decode("utf-8")
        baseline = sha(target)
        record = {"id": ident, "label": label, "file": str(target.relative_to(ROOT)).replace("\\", "/"), "runs": []}
        try:
            if text.count(find) != 1:
                record["verdict"] = "NEEDLE-MISSING" if find not in text else "NEEDLE-AMBIGUOUS"
                rows.append(record)
                continue
            mutated = text.replace(find, repl, 1)
            if mutated == text:
                record["verdict"] = "NO-OP"
                rows.append(record)
                continue
            target.write_bytes(mutated.encode("utf-8"))
            # The edit LANDED, proven by reading it back, before anything is run against it.
            if sha(target) == baseline:
                record["verdict"] = "DID-NOT-APPLY"
                rows.append(record)
                continue
            killed = False
            for cmd in commands:
                code, names = run(cmd)
                record["runs"].append({"command": cmd, "exit": code, "killers": names})
                killed = killed or code != 0
            record["verdict"] = "KILLED" if killed else "SURVIVED"
            rows.append(record)
        finally:
            # Always restore, then PROVE the restore: a campaign that dies mid-mutation
            # otherwise leaves live code mutated. That has happened on this project once.
            target.write_bytes(original)
            assert sha(target) == baseline, "RESTORE FAILED for " + str(target)

    for record in rows:
        print((record["id"] + "  " + record["label"]).ljust(92) + " " + record["verdict"])
        for entry in record["runs"]:
            print("        " + ("exit " + str(entry["exit"])).ljust(8) + " " + entry["command"])
            for name in entry["killers"][:6]:
                print("                 - " + name)
    bad = [record for record in rows if record["verdict"] != "KILLED"]
    print("")
    print("TOTAL " + str(len(rows)) + "  KILLED " + str(len(rows) - len(bad)) + "  PROBLEMS " + str(len(bad)))
    print("")
    print(json.dumps(rows, indent=2, ensure_ascii=False))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
