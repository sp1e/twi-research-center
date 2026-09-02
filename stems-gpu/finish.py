"""TWI finishing: validation and review rendering for a generated candidate.

WHAT THIS IS NOT. It is not "mastering", and it does not produce a loudness-normalised
master. The 2026-08-16 plan specified a FLAC master two-pass normalised to -14 LUFS. That
is wrong for an archive: loudness normalisation is a destructive, irreversible change to
delivered dynamic range, and once it is baked into the only lossless copy the original
performance cannot be recovered. Applying a streaming delivery target to an archival
object also confuses two different jobs.

So the work is split three ways, and each object has exactly one purpose:

  raw      the provider's bytes, untouched, never rewritten here
  archive  a LOSSLESS FLAC conversion of raw -- MEASURED for loudness, never targeted
  review   a 320 kbps MP3 loudness-MATCHED to -14 LUFS, for blind A/B comparison only

Only the review carries a loudness target, because the only reason to match loudness is so
that two candidates can be compared without the louder one winning by being louder. That
comparison is a listening aid; it is not what the listener downloads.

The review is rendered with `linear=true` so the match is a single gain offset rather than
dynamic compression, and with an explicit output sample rate, because loudnorm otherwise
resamples by default and the rate would differ from the archive's silently.
"""
import hashlib
import json
import re
import subprocess

# The layout Task 8 actually writes (twi-orchestrator/src/workflow.ts, objectPrefix).
# NOT the `twi/<id>/assets/<id>` shape the plan's Task 10 assumed -- that pattern matches
# nothing this system produces, and validating against it would reject every real job.
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
OUTPUT_PREFIX_PATTERN = re.compile(
    r"^twi/" + _UUID + r"/jobs/" + _UUID + r"/attempt-\d+/[AB]$"
)

REVIEW_TARGET_LUFS = -14.0
REVIEW_MAX_TRUE_PEAK_DBTP = -1.0
REVIEW_LOUDNESS_RANGE = 11.0
REVIEW_SAMPLE_RATE = 48000
REVIEW_BITRATE = "320k"

# How far the delivered review may sit from its target before the render is refused.
REVIEW_TOLERANCE_LUFS = 0.5
# A rendition that is not the same LENGTH as the raw is not the same recording.
DURATION_TOLERANCE_SECONDS = 0.25

RAW_CONTENT_TYPE = "audio/wav"
ARCHIVE_CONTENT_TYPE = "audio/flac"
REVIEW_CONTENT_TYPE = "audio/mpeg"

REQUIRED_MEASUREMENT_KEYS = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")


def validate_output_prefix(prefix):
    """Return the prefix, or raise ValueError. Every object key is built from this."""
    if not isinstance(prefix, str) or not OUTPUT_PREFIX_PATTERN.match(prefix):
        raise ValueError("output prefix is not a TWI job attempt prefix: " + repr(prefix))
    return prefix


def build_output_keys(prefix):
    validate_output_prefix(prefix)
    return {
        "raw": prefix + "/raw.wav",
        "archive": prefix + "/archive.flac",
        "review": prefix + "/review.mp3",
    }


def build_archive_command(source, destination):
    """Lossless FLAC. No filter graph, no resampling, no loudness target -- by design."""
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-i", str(source),
        "-map", "0:a",
        "-c:a", "flac",
        "-compression_level", "8",
        str(destination),
    ]


def _loudnorm_target():
    return (
        "I=" + str(REVIEW_TARGET_LUFS)
        + ":TP=" + str(REVIEW_MAX_TRUE_PEAK_DBTP)
        + ":LRA=" + str(REVIEW_LOUDNESS_RANGE)
    )


def build_loudness_analysis_command(source):
    """Pass one: measure only. Decodes to nowhere and prints a JSON report on stderr."""
    return [
        "ffmpeg", "-hide_banner", "-nostdin",
        "-i", str(source),
        "-af", _loudnorm_target() + ":print_format=json",
        "-f", "null", "-",
    ]


def build_review_command(source, destination, measured):
    """Pass two: apply the measured offset linearly, at an explicit rate, to MP3."""
    missing = [key for key in REQUIRED_MEASUREMENT_KEYS if key not in measured]
    if missing:
        raise ValueError("measurement is missing " + ", ".join(missing))
    filter_spec = (
        _loudnorm_target()
        + ":measured_I=" + str(measured["input_i"])
        + ":measured_TP=" + str(measured["input_tp"])
        + ":measured_LRA=" + str(measured["input_lra"])
        + ":measured_thresh=" + str(measured["input_thresh"])
        + ":offset=" + str(measured["target_offset"])
        + ":linear=true:print_format=summary"
    )
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-i", str(source),
        "-af", filter_spec,
        "-ar", str(REVIEW_SAMPLE_RATE),
        "-c:a", "libmp3lame",
        "-b:a", REVIEW_BITRATE,
        str(destination),
    ]


def build_finish_commands(raw_path, archive_path, review_path, measured):
    """The three stages, in order. The review is rendered FROM the archive, not the raw."""
    return {
        "archive": build_archive_command(raw_path, archive_path),
        "analysis": build_loudness_analysis_command(archive_path),
        "review": build_review_command(archive_path, review_path, measured),
    }


def digest_of_commands(commands):
    """A stable digest of exactly which commands produced the outputs, for provenance."""
    payload = json.dumps(commands, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_loudnorm_json(stderr):
    """Read the JSON report loudnorm prints AFTER its progress output.

    An unreadable or incomplete report raises rather than defaulting: a silently assumed
    measurement would produce a review that is confidently at the wrong loudness.
    """
    start = stderr.rfind("{") if isinstance(stderr, str) else -1
    if start == -1:
        raise ValueError("no loudnorm JSON report found in ffmpeg output")
    try:
        parsed = json.loads(stderr[start:])
    except json.JSONDecodeError as err:
        raise ValueError("loudnorm JSON report could not be parsed: " + str(err))
    missing = [key for key in REQUIRED_MEASUREMENT_KEYS if key not in parsed]
    if missing:
        raise ValueError("loudnorm report is missing " + ", ".join(missing))
    return parsed


def probe_audio(path):
    """Actual decoded properties of a rendition. Measured, never assumed from the request."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels:format=duration,size",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    report = json.loads(out.stdout)
    stream = (report.get("streams") or [{}])[0]
    fmt = report.get("format") or {}
    return {
        "duration_seconds": float(fmt["duration"]),
        "bytes": int(fmt["size"]),
        "sample_rate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
    }


def run_two_pass_loudnorm(archive_path, review_path, runner=subprocess.run):
    """Measure the archive, then render the review from it with that measurement."""
    analysis = runner(
        build_loudness_analysis_command(archive_path),
        capture_output=True, text=True, check=True,
    )
    measured = parse_loudnorm_json(analysis.stderr)
    runner(
        build_review_command(archive_path, review_path, measured),
        capture_output=True, text=True, check=True,
    )
    return measured


def _rendition(key, content_type, probe, target_lufs):
    entry = {
        "r2_key": key,
        "content_type": content_type,
        "bytes": probe["bytes"],
        "duration_seconds": probe["duration_seconds"],
        "sample_rate": probe["sample_rate"],
        "channels": probe["channels"],
        "loudness_target_lufs": target_lufs,
    }
    for measurement in ("integrated_lufs", "true_peak_dbtp", "loudness_range"):
        if measurement in probe:
            entry[measurement] = probe[measurement]
    return entry


def build_finish_manifest(prefix, raw, archive, review, ffmpeg_version, command_digest):
    """Assemble the manifest, refusing anything that would publish a bad rendition.

    The archive is MEASURED and never gated on loudness -- a quiet, wide-range master is a
    legitimate master. The review IS gated, because a review that missed its target would
    silently bias a blind A/B comparison, which is the only thing it exists for.
    """
    keys = build_output_keys(prefix)

    for name, rendition in (("archive", archive), ("review", review)):
        drift = abs(rendition["duration_seconds"] - raw["duration_seconds"])
        if drift > DURATION_TOLERANCE_SECONDS:
            raise ValueError(
                name + " duration drifted from the raw by " + str(round(drift, 3)) + "s"
            )

    off_target = abs(review["integrated_lufs"] - REVIEW_TARGET_LUFS)
    if off_target > REVIEW_TOLERANCE_LUFS:
        raise ValueError(
            "review is " + str(round(off_target, 2)) + " LUFS from its target"
        )
    if review["true_peak_dbtp"] > REVIEW_MAX_TRUE_PEAK_DBTP:
        raise ValueError(
            "review true peak " + str(review["true_peak_dbtp"]) + " dBTP exceeds the ceiling"
        )

    return {
        "schema_version": 1,
        "prefix": prefix,
        "raw": _rendition(keys["raw"], RAW_CONTENT_TYPE, raw, None),
        "archive": _rendition(keys["archive"], ARCHIVE_CONTENT_TYPE, archive, None),
        "review": _rendition(keys["review"], REVIEW_CONTENT_TYPE, review, REVIEW_TARGET_LUFS),
        "ffmpeg_version": ffmpeg_version,
        "command_digest": command_digest,
    }


def loudness_from_measurement(measured):
    """Map a loudnorm report onto the manifest's measurement names.

    The report describes its INPUT, so these are the properties of the file that was
    analysed -- which is why the archive is measured by analysing the archive itself
    rather than by trusting what the review render was asked to produce.
    """
    return {
        "integrated_lufs": float(measured["input_i"]),
        "true_peak_dbtp": float(measured["input_tp"]),
        "loudness_range": float(measured["input_lra"]),
    }


def iso_millis(moment):
    """`YYYY-MM-DDTHH:MM:SS.sssZ`, the only timestamp shape the TWI schema accepts.

    Built by hand rather than with `isoformat()`, which prints SIX fractional digits and a
    `+00:00` offset -- both of which the CHECK constraint on `twi_job_events.created_at`
    refuses. A timestamp the database rejects would turn a successful finishing job into a
    failed callback, which is the worst place to discover a formatting difference.
    """
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (moment.microsecond // 1000)


def build_twi_callback_payload(job_id, attempt, label, output_prefix, callback_context,
                               call_id, timestamp, manifest=None, error=None):
    """The finishing callback, as the TWI orchestrator's /callback/modal requires it.

    THIS IS NOT THE STEM LAB CALLBACK. `process_job` posts its own, unchanged, snake_case
    payload to a live service and nothing here touches it.

    Every field exists so the receiver can refuse a callback that is not evidence:

      callbackId / nonce  echoed from `callback_context`. The orchestrator minted them before
                          it submitted, so only a callback that came back from THIS submission
                          can carry them. The callback id is also what the database dedupes on.
      callId              the Modal function call id, read inside the container via
                          `modal.current_function_call_id()`. It is the one identifier the
                          orchestrator learned from the submission RESPONSE, so it ties the
                          callback to the exact call rather than to the job.
      prefix              the asset prefix, so a callback cannot be redirected at another
                          candidate's objects.

    A missing or unusable `callback_context` raises rather than sending a callback that names
    no call: an unanswerable callback is refused here, loudly, instead of failing validation on
    the other side with nothing to point at.
    """
    if not isinstance(callback_context, dict):
        raise ValueError("callback_context is required and must be an object")
    callback_id = callback_context.get("callback_id")
    nonce = callback_context.get("nonce")
    if not callback_id or not nonce or callback_id == nonce:
        raise ValueError("callback_context must carry a distinct callback_id and nonce")
    if not call_id:
        raise ValueError("call_id is required: a callback that names no call is not evidence")

    return {
        "schemaVersion": 1,
        "callbackId": callback_id,
        "nonce": nonce,
        "timestamp": timestamp,
        "callId": call_id,
        "jobId": job_id,
        "attempt": int(attempt),
        "label": label,
        "prefix": output_prefix,
        "status": "done" if manifest is not None else "error",
        "manifest": manifest,
        "error": error,
    }


def build_status_response(result):
    """Shape a finished Modal call for /status.

    The Stem Lab shape is returned byte-for-byte as it always was, including its empty
    default: this endpoint serves a live service and a finishing job must not change what
    a stem job looks like to the site's watchdog.
    """
    if isinstance(result, dict) and "manifest" in result:
        return {
            "state": "done",
            "kind": result.get("kind", "finish"),
            "manifest": result["manifest"],
        }
    stems = result.get("stems", []) if isinstance(result, dict) else []
    return {"state": "done", "stems": stems}
