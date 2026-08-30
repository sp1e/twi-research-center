"""Publication-guard harness: the round that closed the hole task8_publication_mutants found.

20 mutants -- 13 predicates against publication-guards.test.ts, 7 call-site deletions against
the contract check. All KILLED at db289a1. Prints JSON so the killing test names can be read
back into the manifest rather than retyped.

A unit test proves a predicate; only the call graph proves the call. Both halves are here.
"""
import hashlib, json, pathlib, re, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
PKG = ROOT / "twi-orchestrator"
UNIT = "npm test --prefix twi-orchestrator -- src/publication-guards.test.ts"
CONTRACTS = "npm run test:twi:contracts"

M = [
 ("P1  preview digest clause dropped", "src/publication-guards.ts", UNIT,
  "if (raw.sha256 !== master.sha256 || raw.sha256 !== preview.sha256) {", "if (raw.sha256 !== master.sha256) {"),
 ("P2  master digest clause dropped", "src/publication-guards.ts", UNIT,
  "if (raw.sha256 !== master.sha256 || raw.sha256 !== preview.sha256) {", "if (raw.sha256 !== preview.sha256) {"),
 ("P3  master never header-checked", "src/publication-guards.ts", UNIT,
  "  assertWavHeader(master.bytes);\n", ""),
 ("P4  provenance content type unchecked", "src/publication-guards.ts", UNIT,
  "if (text === null || contentType !== 'application/json') throw new Error('candidate provenance is missing');",
  "if (text === null) throw new Error('candidate provenance is missing');"),
 ("P5  provenance spec digest unchecked", "src/publication-guards.ts", UNIT,
  "    provenance.specSha256 !== specSha256 ||\n", ""),
 ("P6  provenance label unchecked", "src/publication-guards.ts", UNIT,
  "    provenance.label !== label\n", "    false\n"),
 ("P7  provenance request id unchecked", "src/publication-guards.ts", UNIT,
  "    provenance.providerRequestId !== providerRequestId ||\n", ""),
 ("P8  both-candidates gate weakened", "src/publication-guards.ts", UNIT,
  "if (labels.join('') !== 'AB') throw new Error('both candidates must validate before publication');",
  "if (labels.length === 0) throw new Error('both candidates must validate before publication');"),
 ("P9  provisional count comparison broken", "src/publication-guards.ts", UNIT,
  "if (count !== expected) throw new Error('candidate assets are not all provisional');",
  "if (count === -1) throw new Error('candidate assets are not all provisional');"),
 ("P10 frozen job digest unchecked", "src/publication-guards.ts", UNIT,
  "    job.specSha256 !== payload.specSha256 ||\n", ""),
 ("P11 frozen job idempotency unchecked", "src/publication-guards.ts", UNIT,
  "    job.idempotencyKey !== payload.idempotencyKey\n", "    false\n"),
 ("P12 wav minimum length weakened", "src/publication-guards.ts", UNIT,
  "if (bytes.byteLength < 44) throw new Error('candidate WAV is too short');",
  "if (bytes.byteLength < 4) throw new Error('candidate WAV is too short');"),
 ("P13 wav declared length unchecked", "src/publication-guards.ts", UNIT,
  "  if (view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(40, true) !== bytes.byteLength - 44) {\n    throw new Error('candidate WAV length is invalid');\n  }\n", ""),

 ("C1  audio guard no longer called", "src/workflow.ts", CONTRACTS, "assertCandidateAudio({", "void ({"),
 ("C2  provenance guard no longer called", "src/workflow.ts", CONTRACTS, "assertProvenance({", "void ({"),
 ("C3  both-candidates gate no longer called", "src/workflow.ts", CONTRACTS,
  "assertBothCandidatesValidated(validated.labels);", "void (validated.labels);"),
 ("C4  provisional assertion no longer called", "src/workflow.ts", CONTRACTS,
  "await store.assertAssetsProvisional(payload.projectId, payload.jobId, assetIds);", "void (assetIds);"),
 ("C5  header check no longer called", "src/workflow.ts", CONTRACTS, "assertWavHeader(bytes);", "void (bytes);"),
 ("C6  frozen identity no longer called", "src/db.ts", CONTRACTS,
  "assertFrozenJobMatchesPayload(job, payload);", "void (job);"),
 ("C7  provisional count no longer called", "src/db.ts", CONTRACTS,
  "assertAllProvisional(row?.count, assetIds.length);", "void (row);"),
]

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

rows = []
for label, rel, cmd, needle, repl in M:
    path = PKG / rel
    original = path.read_text(encoding="utf-8"); base = sha(path)
    try:
        if needle not in original:
            rows.append((label, "NEEDLE-MISSING", [])); continue
        mutated = original.replace(needle, repl, 1)
        if mutated == original:
            rows.append((label, "NO-OP", [])); continue
        path.write_text(mutated, encoding="utf-8", newline="\n")
        if repl and repl not in path.read_text(encoding="utf-8"):
            rows.append((label, "APPLY-FAIL", [])); continue
        proc = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        out = proc.stdout + proc.stderr
        names = re.findall(r"^\s*[x×]\s+(.+?)(?:\s+\d+(?:\.\d+)?ms)?$", out, re.M)
        names += re.findall(r"^FAIL\s+(.+)$", out, re.M)
        names = [n.strip() for n in names if len(n.strip()) > 10]
        rows.append((label, "KILLED" if proc.returncode != 0 else "SURVIVED", names[:3]))
    finally:
        path.write_text(original, encoding="utf-8", newline="\n")
        assert sha(path) == base, f"RESTORE FAILED {rel}"

print(json.dumps([{"label": l, "verdict": v, "failed": f} for l, v, f in rows], indent=1))
bad = [r for r in rows if r[1] != "KILLED"]
print(f"\nTOTAL {len(rows)}  KILLED {len(rows)-len(bad)}  PROBLEMS {len(bad)}")
