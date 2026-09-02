"""Task 11 mutation harness: the Modal finishing seam (twi-orchestrator/).

The question this answers is the one a green suite cannot: does the orchestrator suite DETECT
a finishing seam that has been weakened? Task 11 added guards that only ever fire on states the
happy path cannot produce -- a forged callback, a replayed callback, a mastered archive, an
object Modal never uploaded -- and nine of twelve publication mutants once survived this
project's full suite for exactly that reason.

Three groups, and the first is the one that matters most:

  T1-T5   THE ARCHIVE AND THE REVIEW GATE. T1 and T2 are the orchestrator-side twins of Task
          10's F1/F2/F10: they put a loudness target back on the archive, or stop refusing one.
          If either survives, the archive is being mastered and only the Python half notices.
          T3-T5 restore the plan's SUPERSEDED true-peak and tolerance numbers, which disagree
          with what stems-gpu/finish.py enforces.
  T6-T9   THE CALLBACK IS EVIDENCE. Each removes one clause of the proof that a callback
          answers the exact Modal call the Workflow submitted, or one clause of the route's
          authentication.
  T10-T12 PUBLICATION STILL REFUSES. The stored-object cross-check, the database-enforced
          replay refusal, and the money-path rule that no render is bought that cannot be
          finished.
  T13-T14 THE RAW IS STILL READ AS AUDIO. T13 deletes the CALL and T14 deletes a CLAUSE, which
          is the distinction section 15 of scripts/twi-contract-check.mjs exists for: T14 dies
          in the unit suite, T13 dies only in the contract check.

    python docs/superpowers/mutants/harnesses/task11_finishing_mutants.py

Each mutation is applied to ONE file, verified to have LANDED (a needle that no longer matches
is reported as NEEDLE-MISSING, never as a kill), run against the orchestrator suite, and
restored byte-identically against a recorded sha256. A mutation that fails to apply is
indistinguishable from one that got killed, and this project has been fooled that way three
times.
"""
import hashlib
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
PKG = ROOT / "twi-orchestrator"
MANIFEST = PKG / "src" / "finishing" / "manifest.ts"
AUTH = PKG / "src" / "finishing" / "callback-auth.ts"
GUARDS = PKG / "src" / "publication-guards.ts"
SELECT = PKG / "src" / "providers" / "select.ts"
WORKFLOW = PKG / "src" / "workflow.ts"
DB = PKG / "src" / "db.ts"
# The orchestrator suite AND the contract check, because they answer different questions and
# neither substitutes for the other. A unit test proves a PREDICATE; only the contract check
# proves the predicate is still CALLED -- delete the call and every unit test stays green,
# because the function it tests is untouched. T13 is the mutant that proves that is true here.
CMD = "npm test --prefix twi-orchestrator && npm run test:twi:contracts"

NL = chr(10)

ARCHIVE_TARGET_GUARD = (
    "  if (archive.loudness_target_lufs !== null) throw new Error"
    "('archive must never carry a loudness target');\n"
)
TRUE_PEAK_GUARD = (
    "  if ((review.true_peak_dbtp as number) > REVIEW_MAX_TRUE_PEAK_DBTP) {\n"
    "    throw new Error('review true peak exceeds the ceiling');\n"
    "  }\n"
)
CALL_BINDING = (
    "    envelope.callId !== call.callId ||\n"
    "    envelope.callbackId !== call.callbackId ||\n"
    "    envelope.nonce !== call.nonce\n"
)

M = [
    ("T1  archive target refusal deleted", MANIFEST, ARCHIVE_TARGET_GUARD, ""),
    ("T2  review's target applied to the archive too", MANIFEST,
     "if (archive.loudness_target_lufs !== null) throw",
     "if (archive.loudness_target_lufs !== REVIEW_TARGET_LUFS && archive.loudness_target_lufs !== null) throw"),
    ("T3  true-peak ceiling raised to the plan's -0.5", MANIFEST,
     "export const REVIEW_MAX_TRUE_PEAK_DBTP = -1;",
     "export const REVIEW_MAX_TRUE_PEAK_DBTP = -0.5;"),
    ("T4  true-peak ceiling dropped entirely", MANIFEST, TRUE_PEAK_GUARD, ""),
    ("T5  duration drift tolerance widened", MANIFEST,
     "export const DURATION_TOLERANCE_SECONDS = 0.25;",
     "export const DURATION_TOLERANCE_SECONDS = 25;"),
    ("T6  callback no longer has to name its call", MANIFEST, CALL_BINDING, "    false\n"),
    ("T7  an errored finishing job publishes anyway", MANIFEST,
     "  if (envelope.status !== 'done') {", "  if (false) {"),
    ("T8  the shared secret stops being checked", AUTH,
     "if (!secretsMatch(presentedSecret, expectedSecret)) throw new Error('callback_unauthorized');",
     "if (false) throw new Error('callback_unauthorized');"),
    ("T9  the replay window is widened to a year", AUTH,
     "export const CALLBACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;",
     "export const CALLBACK_REPLAY_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;"),
    ("T10 a missing finished object is accepted", GUARDS,
     "    throw new Error(`finished object is missing from storage: ${claim.key}`);",
     "    return;"),
    ("T11 a replayed callback emits a second event", DB,
     "return result.meta.changes === 1 ? 'recorded' : 'replayed';", "return 'recorded';"),
    ("T12 an unconfigured deployment buys a render it cannot finish", SELECT,
     "  finishing !== null && finishing !== undefined && FINISHABLE_MODES.has(mode ?? '');",
     "  FINISHABLE_MODES.has(mode ?? '');"),
    ("T13 the raw is never read as audio at all", WORKFLOW,
     "        assertRawWavIntegrity(rawBytes);" + NL, ""),
    ("T14 the declared RIFF length stops being checked", GUARDS,
     "  if (view.getUint32(4, true) !== bytes.byteLength - 8) throw new Error"
     "('candidate WAV length is invalid');" + NL, ""),
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    rows = []
    for label, target, find, repl in M:
        original = target.read_text(encoding="utf-8")
        baseline = sha(target)
        try:
            if find not in original:
                rows.append((label, "NEEDLE-MISSING"))
                continue
            mutated = original.replace(find, repl, 1)
            if mutated == original:
                rows.append((label, "NO-OP"))
                continue
            target.write_text(mutated, encoding="utf-8", newline="\n")
            # The edit LANDED, proven by reading it back, before anything is run against it.
            if sha(target) == baseline:
                rows.append((label, "DID-NOT-APPLY"))
                continue
            proc = subprocess.run(
                CMD, cwd=ROOT, shell=True, capture_output=True,
                text=True, encoding="utf-8", errors="replace",
            )
            rows.append((label, "KILLED" if proc.returncode != 0 else "SURVIVED"))
        finally:
            # Always restore, then PROVE the restore: a campaign that dies mid-mutation
            # otherwise leaves live code mutated. That has happened on this project once.
            target.write_text(original, encoding="utf-8", newline="\n")
            assert sha(target) == baseline, "RESTORE FAILED for " + str(target)

    for label, verdict in rows:
        print(label.ljust(46) + " " + verdict)
    bad = [row for row in rows if row[1] != "KILLED"]
    print("")
    print("TOTAL " + str(len(rows)) + "  KILLED " + str(len(rows) - len(bad)) + "  PROBLEMS " + str(len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
