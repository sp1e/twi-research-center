"""Task 8 FIRST-PASS publication harness -- the round that found the hole.

12 mutants against the publication invariants where they lived INLINE in workflow.ts and
db.ts at 9377337. NINE SURVIVED the full Workflow integration suite. That result is why
publication-guards.ts exists.

IT WILL REPORT NEEDLE-MISSING AT HEAD, BY DESIGN. The code it mutates was extracted in
db289a1. It is kept as the reproducible record of the finding, not as a live campaign.
To reproduce the original result: git checkout 9377337, then run it.
"""
import hashlib, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
PKG = ROOT / "twi-orchestrator"
TEST = "test/workflow.test.ts"

M = [
 ("V1  preview hash check dropped", "src/workflow.ts",
  "if (candidate.raw.sha256 !== candidate.master.sha256 || candidate.raw.sha256 !== candidate.preview.sha256) {",
  "if (candidate.raw.sha256 !== candidate.master.sha256) {"),
 ("V2  provenance specSha256 unchecked", "src/workflow.ts",
  "          provenance.specSha256 !== payload.specSha256 ||\n", ""),
 ("V3  provenance label unchecked", "src/workflow.ts",
  "          provenance.label !== candidate.label\n", "          false\n"),
 ("V4  provenance content type unchecked", "src/workflow.ts",
  "if (!provenanceObject || provenanceObject.httpMetadata?.contentType !== 'application/json') {",
  "if (!provenanceObject) {"),
 ("V5  provisional assertion removed", "src/workflow.ts",
  "      await store.assertAssetsProvisional(payload.projectId, payload.jobId, assetIds);\n", ""),
 ("V6  both-candidates guard removed", "src/workflow.ts",
  "if (validated.labels.join('') !== 'AB') throw new Error('both candidates must validate before publication');",
  "if (false) throw new Error('both candidates must validate before publication');"),
 ("V7  master WAV never revalidated", "src/workflow.ts",
  "        assertWav(master);\n", ""),
 ("V8  provisional count comparison broken", "src/db.ts",
  "if (row?.count !== assetIds.length) throw new Error('candidate assets are not all provisional');",
  "if (row?.count === -1) throw new Error('candidate assets are not all provisional');"),
 ("V9  frozen job digest unchecked", "src/db.ts",
  "      job.specSha256 !== payload.specSha256 ||\n", ""),
 ("V10 transition event key drops attempt", "src/db.ts",
  "eventKey: `${jobId}:${attempt}:${toStatus}`,", "eventKey: `${jobId}:${toStatus}`,"),
 ("V11 publish event key drops attempt", "src/workflow.ts",
  "eventKey: `${payload.jobId}:${payload.attempt}:complete`,", "eventKey: `${payload.jobId}:complete`,"),
 ("V12 finish transitions from the wrong state", "src/workflow.ts",
  "await store.transition(payload.jobId, payload.attempt, 'ingesting', 'finishing', 'finishing', now);",
  "await store.transition(payload.jobId, payload.attempt, 'generating', 'finishing', 'finishing', now);"),
]

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

rows = []
for label, rel, needle, repl in M:
    path = PKG / rel
    original = path.read_text(encoding="utf-8")
    base = sha(path)
    try:
        if needle not in original:
            rows.append((label, "NEEDLE-MISSING", "")); continue
        mutated = original.replace(needle, repl, 1)
        if mutated == original:
            rows.append((label, "NO-OP", "")); continue
        path.write_text(mutated, encoding="utf-8", newline="\n")
        proc = subprocess.run(f"npm test --prefix twi-orchestrator -- {TEST}",
                              cwd=ROOT, shell=True, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        out = proc.stdout + proc.stderr
        failed = re.findall(r"^\s*[x\u00d7]\s+(.+?)(?:\s+\d+ms)?$", out, re.M)
        failed = [f for f in failed if len(f) > 12][:2]
        rows.append((label, "KILLED" if proc.returncode != 0 else "SURVIVED", " | ".join(failed)))
    finally:
        path.write_text(original, encoding="utf-8", newline="\n")
        assert sha(path) == base, f"RESTORE FAILED {rel}"

for label, verdict, who in rows:
    print(f"{label:<42} {verdict:<10} {who[:88]}")
surv = [r for r in rows if r[1] != "KILLED"]
print(f"\nTOTAL {len(rows)}  KILLED {len(rows)-len(surv)}  SURVIVED/OTHER {len(surv)}")
