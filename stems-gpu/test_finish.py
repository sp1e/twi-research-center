"""Run with:  python stems-gpu/test_finish.py  (plain asserts, no pytest dependency)."""
import json

import finish

PREFIX = "twi/11111111-1111-4111-8111-111111111111/jobs/33333333-3333-4333-8333-333333333333/attempt-0/A"

MEASURED = {
    "input_i": "-18.7",
    "input_tp": "-3.2",
    "input_lra": "9.4",
    "input_thresh": "-29.1",
    "target_offset": "0.4",
}


def _rendition(**over):
    base = {"bytes": 100, "duration_seconds": 30.0, "sample_rate": 48000, "channels": 2}
    base.update(over)
    return base


def test_prefix_accepts_the_layout_task_8_actually_writes():
    assert finish.validate_output_prefix(PREFIX) == PREFIX


def test_prefix_rejects_anything_that_could_escape_the_job():
    bad_prefixes = [
        "twi/../etc/passwd",
        "twi/11111111-1111-4111-8111-111111111111/assets/33333333-3333-4333-8333-333333333333",
        PREFIX + "/..",
        PREFIX[:-1] + "C",
        PREFIX.replace("attempt-0", "attempt-x"),
        PREFIX.upper(),
        "stems/j1",
        "",
    ]
    for bad in bad_prefixes:
        try:
            finish.validate_output_prefix(bad)
        except ValueError:
            continue
        raise AssertionError("expected ValueError for " + repr(bad))


def test_archive_is_lossless_and_carries_no_loudness_target():
    cmd = finish.build_archive_command("in.wav", "out.flac")
    joined = " ".join(cmd)
    assert cmd[0] == "ffmpeg"
    assert "flac" in joined
    assert "loudnorm" not in joined, "an archival master must never be loudness-normalised"
    assert "-ar" not in cmd, "resampling the archive would not be lossless"
    assert all(isinstance(part, str) for part in cmd)


def test_analysis_pass_asks_for_machine_readable_measurements():
    cmd = finish.build_loudness_analysis_command("in.flac")
    joined = " ".join(cmd)
    assert "print_format=json" in joined
    assert "-f" in cmd and "null" in cmd
    assert "I=" + str(finish.REVIEW_TARGET_LUFS) in joined
    assert "TP=" + str(finish.REVIEW_MAX_TRUE_PEAK_DBTP) in joined


def test_review_pass_is_linear_targeted_and_explicitly_rated():
    cmd = finish.build_review_command("in.flac", "out.mp3", MEASURED)
    joined = " ".join(cmd)
    assert "linear=true" in joined, "non-linear loudnorm applies dynamic compression"
    for key, value in [
        ("measured_I", MEASURED["input_i"]),
        ("measured_TP", MEASURED["input_tp"]),
        ("measured_LRA", MEASURED["input_lra"]),
        ("measured_thresh", MEASURED["input_thresh"]),
        ("offset", MEASURED["target_offset"]),
    ]:
        assert key + "=" + value in joined
    assert "-ar" in cmd and str(finish.REVIEW_SAMPLE_RATE) in cmd
    assert "-b:a" in cmd and finish.REVIEW_BITRATE in cmd
    assert all(isinstance(part, str) for part in cmd)


def test_every_output_lands_under_the_given_prefix():
    keys = finish.build_output_keys(PREFIX)
    assert keys["raw"] == PREFIX + "/raw.wav"
    assert keys["archive"] == PREFIX + "/archive.flac"
    assert keys["review"] == PREFIX + "/review.mp3"
    assert all(key.startswith(PREFIX + "/") for key in keys.values())


def test_finish_commands_cover_all_three_stages():
    commands = finish.build_finish_commands("raw.wav", "archive.flac", "review.mp3", MEASURED)
    assert set(commands) == {"archive", "analysis", "review"}
    for cmd in commands.values():
        assert cmd[0] == "ffmpeg"
        assert all(isinstance(part, str) for part in cmd)


def test_loudnorm_json_is_parsed_out_of_the_trailing_ffmpeg_report():
    stderr = "size=N/A time=00:00:30\n" + json.dumps(
        {
            "input_i": "-18.7",
            "input_tp": "-3.2",
            "input_lra": "9.4",
            "input_thresh": "-29.1",
            "output_i": "-14.0",
            "target_offset": "0.4",
        }
    )
    parsed = finish.parse_loudnorm_json(stderr)
    assert parsed["input_i"] == "-18.7"
    assert parsed["target_offset"] == "0.4"


def test_unparseable_measurement_is_an_error_not_a_default():
    for bad in ["no json here", "", "{not json}", json.dumps({"input_i": "-1"})]:
        try:
            finish.parse_loudnorm_json(bad)
        except ValueError:
            continue
        raise AssertionError("expected ValueError for " + repr(bad))


def test_manifest_separates_the_unchanged_archive_from_the_matched_review():
    manifest = finish.build_finish_manifest(
        prefix=PREFIX,
        raw=_rendition(bytes=100),
        archive=_rendition(bytes=200, integrated_lufs=-18.7, true_peak_dbtp=-3.2, loudness_range=9.4),
        review=_rendition(bytes=300, integrated_lufs=-14.0, true_peak_dbtp=-1.2, loudness_range=9.1),
        ffmpeg_version="ffmpeg version 7.1",
        command_digest="abc123",
    )
    assert manifest["schema_version"] == 1
    assert manifest["archive"]["loudness_target_lufs"] is None, "the archive is measured, never targeted"
    assert manifest["review"]["loudness_target_lufs"] == finish.REVIEW_TARGET_LUFS
    assert manifest["raw"]["content_type"] == "audio/wav"
    assert manifest["archive"]["content_type"] == "audio/flac"
    assert manifest["review"]["content_type"] == "audio/mpeg"
    assert manifest["archive"]["r2_key"] == PREFIX + "/archive.flac"
    assert manifest["ffmpeg_version"] == "ffmpeg version 7.1"
    assert manifest["command_digest"] == "abc123"


def test_manifest_refuses_a_review_that_missed_its_target():
    def build(integrated, peak):
        return finish.build_finish_manifest(
            prefix=PREFIX,
            raw=_rendition(),
            archive=_rendition(integrated_lufs=-18.0, true_peak_dbtp=-3.0, loudness_range=9.0),
            review=_rendition(integrated_lufs=integrated, true_peak_dbtp=peak, loudness_range=9.0),
            ffmpeg_version="v",
            command_digest="d",
        )

    build(-14.4, -1.2)
    for integrated, peak in [(-11.0, -1.2), (-17.0, -1.2), (-14.0, -0.2)]:
        try:
            build(integrated, peak)
        except ValueError:
            continue
        raise AssertionError("expected ValueError for " + str(integrated) + " LUFS / " + str(peak) + " dBTP")


def test_manifest_never_gates_the_archive_on_a_loudness_target():
    quiet = finish.build_finish_manifest(
        prefix=PREFIX,
        raw=_rendition(),
        archive=_rendition(integrated_lufs=-31.0, true_peak_dbtp=-9.0, loudness_range=18.0),
        review=_rendition(integrated_lufs=-14.0, true_peak_dbtp=-1.2, loudness_range=9.0),
        ffmpeg_version="v",
        command_digest="d",
    )
    assert quiet["archive"]["integrated_lufs"] == -31.0


def test_manifest_refuses_an_archive_whose_duration_drifted_from_the_raw():
    try:
        finish.build_finish_manifest(
            prefix=PREFIX,
            raw=_rendition(duration_seconds=30.0),
            archive=_rendition(duration_seconds=27.0, integrated_lufs=-18.0, true_peak_dbtp=-3.0, loudness_range=9.0),
            review=_rendition(integrated_lufs=-14.0, true_peak_dbtp=-1.2, loudness_range=9.0),
            ffmpeg_version="v",
            command_digest="d",
        )
    except ValueError as err:
        assert "duration" in str(err)
        return
    raise AssertionError("expected ValueError")



def test_status_keeps_the_existing_stem_lab_shape_untouched():
    assert finish.build_status_response({"stems": [{"name": "vocals"}]}) == {
        "state": "done",
        "stems": [{"name": "vocals"}],
    }


def test_status_defaults_to_the_stem_lab_shape_when_a_result_carries_neither():
    assert finish.build_status_response({}) == {"state": "done", "stems": []}


def test_status_reports_a_finish_manifest_without_pretending_it_has_stems():
    response = finish.build_status_response({"kind": "finish", "manifest": {"schema_version": 1}})
    assert response["state"] == "done"
    assert response["kind"] == "finish"
    assert response["manifest"] == {"schema_version": 1}
    assert "stems" not in response



def test_loudness_measurement_maps_the_input_report_not_the_target():
    mapped = finish.loudness_from_measurement(MEASURED)
    assert mapped == {"integrated_lufs": -18.7, "true_peak_dbtp": -3.2, "loudness_range": 9.4}


TESTS = [
    test_prefix_accepts_the_layout_task_8_actually_writes,
    test_prefix_rejects_anything_that_could_escape_the_job,
    test_archive_is_lossless_and_carries_no_loudness_target,
    test_analysis_pass_asks_for_machine_readable_measurements,
    test_review_pass_is_linear_targeted_and_explicitly_rated,
    test_every_output_lands_under_the_given_prefix,
    test_finish_commands_cover_all_three_stages,
    test_loudnorm_json_is_parsed_out_of_the_trailing_ffmpeg_report,
    test_unparseable_measurement_is_an_error_not_a_default,
    test_manifest_separates_the_unchanged_archive_from_the_matched_review,
    test_manifest_refuses_a_review_that_missed_its_target,
    test_manifest_never_gates_the_archive_on_a_loudness_target,
    test_manifest_refuses_an_archive_whose_duration_drifted_from_the_raw,
    test_status_keeps_the_existing_stem_lab_shape_untouched,
    test_status_defaults_to_the_stem_lab_shape_when_a_result_carries_neither,
    test_status_reports_a_finish_manifest_without_pretending_it_has_stems,
    test_loudness_measurement_maps_the_input_report_not_the_target,
]

if __name__ == "__main__":
    for fn in TESTS:
        fn()
        print("ok  " + fn.__name__)
    print("all " + str(len(TESTS)) + " finish tests passed")
