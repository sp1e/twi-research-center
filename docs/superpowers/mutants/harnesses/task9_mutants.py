"""Task 9 mutation harness: the Lyria adapter, the WAV header reader, provider selection.

17 mutants, all KILLED at 9377337, each by the test named in the table. Run from anywhere:
    python docs/superpowers/mutants/harnesses/task9_mutants.py

Restores every file byte-identically in a `finally` and asserts the sha256 matches, because
a campaign that crashes mid-mutation leaves live code mutated -- which has happened here.
"""
import hashlib, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[4]

MUTANTS = [
    ("wav",   "src/audio/wav.ts",         "offset = body + size + (size % 2);", "offset = body + size;",
     "steps over the pad byte"),
    ("wav",   "src/audio/wav.ts",         "if (body + size > bytes.byteLength) throw new RangeError(`WAV chunk \"${id}\" runs past the end of the payload`);",
     "if (false) throw new RangeError('unreachable');", "refuses a chunk that claims more bytes"),
    ("wav",   "src/audio/wav.ts",         "let offset = 12;", "let offset = 36;",
     "reads a file whose data chunk is preceded by metadata"),
    ("wav",   "src/audio/wav.ts",         "if (id === 'fmt ' && size >= 16) {", "if (id === 'fmt ' && size >= 18) {",
     "reads a file whose data chunk is preceded by metadata"),
    ("wav",   "src/audio/wav.ts",         "durationSeconds: dataBytes / bytesPerFrame / format.sampleRate,",
     "durationSeconds: dataBytes / format.sampleRate,", "reads a file whose data chunk is preceded by metadata"),

    ("lyria", "src/providers/lyria.ts",   "if (spec.intent.durationSeconds > LYRIA_MAX_DURATION_SECONDS) {",
     "if (spec.intent.durationSeconds >= LYRIA_MAX_DURATION_SECONDS) {", "accepts a render at exactly the supported maximum"),
    ("lyria", "src/providers/lyria.ts",   "export const LYRIA_MAX_DURATION_SECONDS = 184;",
     "export const LYRIA_MAX_DURATION_SECONDS = 240;", "refuses a longer render than Lyria supports"),
    ("lyria", "src/providers/lyria.ts",   "if (payloads.length > 1) {", "if (payloads.length > 2) {",
     "refuses to guess when a response carries more than one audio block"),
    ("lyria", "src/providers/lyria.ts",   "if (status === 429) {", "if (status === 430) {",
     "maps rate limiting to provider_unavailable"),
    ("lyria", "src/providers/lyria.ts",   "if (status >= 500) {", "if (status >= 600) {",
     "leaves a server error ambiguous"),
    ("lyria", "src/providers/lyria.ts",   "throw new ProviderError('provider_unavailable', 'the provider could not be reached', null);",
     "throw new ProviderError('provider_unavailable', 'the provider could not be reached', false);",
     "leaves a transport failure ambiguous"),
    ("lyria", "src/providers/lyria.ts",   "if (spec.sound.imageAssetIds.length > 0) {", "if (spec.sound.imageAssetIds.length > 1) {",
     "refuses image-conditioned specs"),
    ("lyria", "src/providers/lyria.ts",   "throw new ProviderError('provider_invalid_audio', 'the provider returned audio that is not a WAV', true);",
     "throw new ProviderError('provider_rejected', 'the provider returned audio that is not a WAV', true);",
     "rejects a decodable payload that is not a RIFF/WAVE container"),

    ("select", "src/providers/select.ts", "if (mode === 'fake') return new DeterministicFakeMusicProvider();",
     "if (mode !== 'lyria') return new DeterministicFakeMusicProvider();", "refuses an unrecognised mode"),
    ("select", "src/providers/select.ts", "if (mode === 'lyria' && isPresent(apiKey)) {", "if (mode === 'lyria') {",
     "refuses lyria mode without an api key"),
    ("select", "src/providers/select.ts", "return !(error.code === 'provider_unavailable' && error.charged === false);",
     "return !(error.code === 'provider_unavailable');", "forbids retrying an ambiguous call"),
    ("select", "src/providers/select.ts", "const FINISHABLE_MODES: ReadonlySet<string> = new Set(['fake']);",
     "const FINISHABLE_MODES: ReadonlySet<string> = new Set(['fake', 'lyria']);",
     "reports that a paid render cannot yet be finished"),
]

TEST_FILE = {"wav": "src/audio/wav.test.ts", "lyria": "src/providers/lyria.test.ts", "select": "src/providers/select.test.ts"}

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def run(test_file):
    return subprocess.run(
        f"npm test --prefix twi-orchestrator -- {test_file}",
        cwd=ROOT, shell=True, capture_output=True, text=True, encoding="utf-8", errors="replace")

results = []
for index, (group, rel, needle, replacement, killer) in enumerate(MUTANTS, start=1):
    path = ROOT / "twi-orchestrator" / rel
    original = path.read_text(encoding="utf-8")
    baseline = sha(path)
    try:
        if needle not in original:
            results.append((index, rel, "NEEDLE-MISSING", killer)); continue
        mutated = original.replace(needle, replacement, 1)
        if mutated == original:
            results.append((index, rel, "NO-OP", killer)); continue
        path.write_text(mutated, encoding="utf-8", newline="\n")
        if replacement not in path.read_text(encoding="utf-8"):
            results.append((index, rel, "APPLY-FAIL", killer)); continue
        proc = run(TEST_FILE[group])
        out = proc.stdout + proc.stderr
        named = any(killer in line and "x " in line.lower() for line in out.splitlines()) or \
                any(killer in line for line in out.splitlines() if line.strip().startswith(("×", "x")))
        verdict = "KILLED" if (proc.returncode != 0 and killer in out) else \
                  ("SURVIVED" if proc.returncode == 0 else "KILLED-BUT-UNNAMED")
        results.append((index, rel, verdict, killer))
    finally:
        path.write_text(original, encoding="utf-8", newline="\n")
        assert sha(path) == baseline, f"RESTORE FAILED for {rel}"

print("idx | file | verdict | expected killer")
for r in results:
    print(f"M{r[0]:<2} | {r[1]:<26} | {r[2]:<18} | {r[3]}")
bad = [r for r in results if r[2] != "KILLED"]
print(f"\nTOTAL {len(results)}  KILLED {len(results)-len(bad)}  PROBLEMS {len(bad)}")
sys.exit(1 if bad else 0)
