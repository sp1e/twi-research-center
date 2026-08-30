"""Task 10 mutation harness: the finishing rules (stems-gpu/finish.py).

12 mutants, all KILLED at ce2c775. The ones that matter most are F1, F2 and F10 -- they put a
loudness target back on the ARCHIVE, which is the exact defect the plan originally specified
and this task refused to build. If those ever survive, the archive is being mastered again.

    python docs/superpowers/mutants/harnesses/task10_finish_mutants.py
"""
import hashlib
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
TARGET = ROOT / "stems-gpu" / "finish.py"
CMD = "python stems-gpu/test_finish.py"

TRUE_PEAK_GUARD = (
    '    if review["true_peak_dbtp"] > REVIEW_MAX_TRUE_PEAK_DBTP:\n'
    '        raise ValueError(\n'
    '            "review true peak " + str(review["true_peak_dbtp"]) + " dBTP exceeds the ceiling"\n'
    '        )\n'
)

MISSING_KEYS_GUARD = (
    '    missing = [key for key in REQUIRED_MEASUREMENT_KEYS if key not in parsed]\n'
    '    if missing:\n'
    '        raise ValueError("loudnorm report is missing " + ", ".join(missing))\n'
)

M = [
    ("F1  archive gains a loudness target",
     '"-c:a", "flac",', '"-af", "loudnorm=I=-14.0", "-c:a", "flac",'),
    ("F2  archive gets resampled",
     '"-c:a", "flac",', '"-ar", "44100", "-c:a", "flac",'),
    ("F3  review loudnorm stops being linear",
     '+ ":linear=true:print_format=summary"', '+ ":print_format=summary"'),
    ("F4  review output rate left implicit",
     '        "-ar", str(REVIEW_SAMPLE_RATE),\n', ''),
    ("F5  review loudness tolerance widened",
     'REVIEW_TOLERANCE_LUFS = 0.5', 'REVIEW_TOLERANCE_LUFS = 5.0'),
    ("F6  review true-peak ceiling dropped", TRUE_PEAK_GUARD, ''),
    ("F7  duration drift tolerance widened",
     'DURATION_TOLERANCE_SECONDS = 0.25', 'DURATION_TOLERANCE_SECONDS = 25.0'),
    ("F8  prefix accepts any label letter",
     r'/attempt-\d+/[AB]$', r'/attempt-\d+/[A-Z]$'),
    ("F9  incomplete loudnorm report accepted", MISSING_KEYS_GUARD, ''),
    ("F10 archive given a loudness target",
     '_rendition(keys["archive"], ARCHIVE_CONTENT_TYPE, archive, None)',
     '_rendition(keys["archive"], ARCHIVE_CONTENT_TYPE, archive, REVIEW_TARGET_LUFS)'),
    ("F11 archive written as wav",
     '"archive": prefix + "/archive.flac",', '"archive": prefix + "/archive.wav",'),
    ("F12 stem results reshaped as finish",
     'if isinstance(result, dict) and "manifest" in result:', 'if isinstance(result, dict):'),
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    rows = []
    for label, find, repl in M:
        original = TARGET.read_text(encoding="utf-8")
        baseline = sha(TARGET)
        try:
            if find not in original:
                rows.append((label, "NEEDLE-MISSING"))
                continue
            mutated = original.replace(find, repl, 1)
            if mutated == original:
                rows.append((label, "NO-OP"))
                continue
            TARGET.write_text(mutated, encoding="utf-8", newline="\n")
            proc = subprocess.run(
                CMD, cwd=ROOT, shell=True, capture_output=True,
                text=True, encoding="utf-8", errors="replace",
            )
            rows.append((label, "KILLED" if proc.returncode != 0 else "SURVIVED"))
        finally:
            # Always restore, then PROVE the restore: a campaign that dies mid-mutation
            # otherwise leaves live code mutated. That has happened on this project once.
            TARGET.write_text(original, encoding="utf-8", newline="\n")
            assert sha(TARGET) == baseline, "RESTORE FAILED for " + str(TARGET)

    for label, verdict in rows:
        print(label.ljust(40) + " " + verdict)
    bad = [row for row in rows if row[1] != "KILLED"]
    print("")
    print("TOTAL " + str(len(rows)) + "  KILLED " + str(len(rows) - len(bad)) + "  PROBLEMS " + str(len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
