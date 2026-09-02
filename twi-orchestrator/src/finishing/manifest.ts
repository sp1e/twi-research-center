/*
 * The invariants that stand between a Modal finishing callback and a published render.
 *
 * WHY THE PLAN'S STEP 4 IS NOT IMPLEMENTED AS WRITTEN. It asks for a "master FLAC and MP3
 * preview" with `-1.5 <= truePeakDbtp <= -0.5` and `-15 <= integratedLufs <= -13`. All three
 * parts were superseded by what Task 10 actually shipped:
 *
 *   - the objects are `archive.flac` and `review.mp3`. The word MASTER was removed on purpose;
 *   - the true-peak range disagrees with the shipped code. `stems-gpu/finish.py` enforces
 *     `true_peak_dbtp <= -1.0`. The plan's range would ACCEPT -0.7, which finish.py already
 *     REJECTS, and would REJECT -2.0, which finish.py accepts and which is fine. Two gates
 *     that disagree about the same object are worse than one;
 *   - the loudness window applies to the REVIEW ONLY. A quiet, wide-range archive is a
 *     legitimate archive.
 *
 * So the constants below MIRROR finish.py's, by name, and `assertFinishManifest` re-validates
 * against those rather than inventing a second opinion. If finish.py's constants move, these
 * must move with them; `src/finishing/manifest.test.ts` pins the four values so a silent
 * divergence is a failing test rather than a production surprise.
 *
 * THE ARCHIVE IS NEVER MASTERED. finish.py deliberately records
 * `archive.loudness_target_lufs = None`, and mutants F1/F2/F10 in
 * docs/superpowers/mutants/harnesses/task10_finish_mutants.py exist to catch anyone putting a
 * target back on it. `assertFinishManifest` is the orchestrator-side half of that guard: a
 * manifest claiming a targeted archive is refused here even if the Python were changed.
 */

import type { CandidateLabel } from '../providers/types';

/** Mirrors `REVIEW_TARGET_LUFS` in stems-gpu/finish.py. */
export const REVIEW_TARGET_LUFS = -14;
/** Mirrors `REVIEW_MAX_TRUE_PEAK_DBTP` in stems-gpu/finish.py. */
export const REVIEW_MAX_TRUE_PEAK_DBTP = -1;
/** Mirrors `REVIEW_TOLERANCE_LUFS` in stems-gpu/finish.py. */
export const REVIEW_TOLERANCE_LUFS = 0.5;
/** Mirrors `DURATION_TOLERANCE_SECONDS` in stems-gpu/finish.py. */
export const DURATION_TOLERANCE_SECONDS = 0.25;

export const RAW_CONTENT_TYPE = 'audio/wav';
export const ARCHIVE_CONTENT_TYPE = 'audio/flac';
export const REVIEW_CONTENT_TYPE = 'audio/mpeg';

export type RenditionName = 'raw' | 'archive' | 'review';

const CONTENT_TYPES: Record<RenditionName, string> = {
  raw: RAW_CONTENT_TYPE,
  archive: ARCHIVE_CONTENT_TYPE,
  review: REVIEW_CONTENT_TYPE,
};

const FILE_NAMES: Record<RenditionName, string> = {
  raw: 'raw.wav',
  archive: 'archive.flac',
  review: 'review.mp3',
};

export const RENDITIONS: readonly RenditionName[] = ['raw', 'archive', 'review'];

/** What the Workflow submitted, kept as the durable result of `submit-finish-{label}`. */
export interface FinishCallRecord {
  jobId: string;
  attempt: number;
  label: CandidateLabel;
  prefix: string;
  callId: string;
  callbackId: string;
  nonce: string;
  rawSizeBytes: number;
  rawDurationSeconds: number | null;
}

export interface FinishCallbackEnvelope {
  /**
   * Carried on the parsed value, not merely checked and dropped. The route forwards this
   * envelope to the Workflow as JSON text and the Workflow re-parses it with this same
   * function, so a field that survives validation but not the round trip makes the second
   * parse fail on the first one's own output.
   */
  schemaVersion: 1;
  callbackId: string;
  nonce: string;
  timestamp: string;
  callId: string;
  jobId: string;
  attempt: number;
  label: CandidateLabel;
  prefix: string;
  status: 'done' | 'error';
  manifest: Record<string, unknown> | null;
  error: string | null;
}

export interface ValidatedRendition {
  key: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number;
}

export const expectedFinishKeys = (prefix: string): Record<RenditionName, string> => ({
  raw: `${prefix}/${FILE_NAMES.raw}`,
  archive: `${prefix}/${FILE_NAMES.archive}`,
  review: `${prefix}/${FILE_NAMES.review}`,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const SHA256_HEX = /^[0-9a-f]{64}$/;

const CALLBACK_KEYS = [
  'schemaVersion',
  'callbackId',
  'nonce',
  'timestamp',
  'callId',
  'jobId',
  'attempt',
  'label',
  'prefix',
  'status',
  'manifest',
  'error',
] as const;

const invalidEnvelope = (): never => {
  throw new Error('invalid callback envelope');
};

/**
 * Reads the callback body into a known shape, or refuses it.
 *
 * `error` is OPTIONAL on the wire and normalised to `null`, because Modal's own success path
 * has no reason to send it; everything else must be present and exactly typed. Extra keys are
 * refused rather than ignored: an envelope this route does not fully understand is not one it
 * should be forwarding into a Workflow.
 */
export const parseFinishCallback = (value: unknown): FinishCallbackEnvelope => {
  if (!isObject(value)) return invalidEnvelope();
  const unexpected = Object.keys(value).filter((key) => !(CALLBACK_KEYS as readonly string[]).includes(key));
  if (unexpected.length > 0) return invalidEnvelope();

  const status = value.status;
  if (
    value.schemaVersion !== 1 ||
    !isNonBlank(value.callbackId) ||
    !isNonBlank(value.nonce) ||
    !isNonBlank(value.timestamp) ||
    !isNonBlank(value.callId) ||
    !isNonBlank(value.jobId) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 0 ||
    (value.label !== 'A' && value.label !== 'B') ||
    !isNonBlank(value.prefix) ||
    (status !== 'done' && status !== 'error')
  ) {
    return invalidEnvelope();
  }

  const manifest = value.manifest ?? null;
  if (status === 'done' && !isObject(manifest)) return invalidEnvelope();
  if (manifest !== null && !isObject(manifest)) return invalidEnvelope();
  const error = value.error ?? null;
  if (error !== null && !isNonBlank(error)) return invalidEnvelope();

  return {
    schemaVersion: 1,
    callbackId: value.callbackId,
    nonce: value.nonce,
    timestamp: value.timestamp,
    callId: value.callId,
    jobId: value.jobId,
    attempt: value.attempt as number,
    label: value.label,
    prefix: value.prefix,
    status,
    manifest: isObject(manifest) ? manifest : null,
    error: isNonBlank(error) ? error : null,
  };
};

/**
 * The callback must NAME the exact call it answers — job, attempt, label, asset prefix, the
 * Modal call id and the per-call nonce. A callback that names a different call is not evidence
 * about this one, and a Workflow that accepted it would publish audio it never commissioned.
 */
export const assertCallbackBindsCall = (call: FinishCallRecord, envelope: FinishCallbackEnvelope): void => {
  if (
    envelope.jobId !== call.jobId ||
    envelope.attempt !== call.attempt ||
    envelope.label !== call.label ||
    envelope.prefix !== call.prefix ||
    envelope.callId !== call.callId ||
    envelope.callbackId !== call.callbackId ||
    envelope.nonce !== call.nonce
  ) {
    throw new Error('callback does not answer this finishing call');
  }
  if (envelope.status !== 'done') {
    throw new Error(`finishing failed: ${envelope.error ?? 'no reason given'}`);
  }
};

const invalidManifest = (): never => {
  throw new Error('finish manifest is invalid');
};

const readRendition = (manifest: Record<string, unknown>, name: RenditionName, key: string): Record<string, unknown> => {
  const rendition = manifest[name];
  if (
    !isObject(rendition) ||
    rendition.r2_key !== key ||
    rendition.content_type !== CONTENT_TYPES[name] ||
    !isPositiveInteger(rendition.bytes) ||
    !isPositive(rendition.duration_seconds) ||
    !isPositiveInteger(rendition.sample_rate) ||
    !isPositiveInteger(rendition.channels)
  ) {
    return invalidManifest();
  }
  return rendition;
};

/**
 * Validates the manifest Modal reported against the call the Workflow submitted.
 *
 * Returns the three renditions in the small shape the Workflow carries across a step
 * boundary — never bytes, never the manifest itself.
 */
export const assertFinishManifest = (
  call: FinishCallRecord,
  manifest: Record<string, unknown>,
): Record<RenditionName, ValidatedRendition> => {
  if (manifest.schema_version !== 1 || manifest.prefix !== call.prefix) return invalidManifest();
  if (!isNonBlank(manifest.ffmpeg_version)) return invalidManifest();
  if (typeof manifest.command_digest !== 'string' || !SHA256_HEX.test(manifest.command_digest)) return invalidManifest();

  const keys = expectedFinishKeys(call.prefix);
  const raw = readRendition(manifest, 'raw', keys.raw);
  const archive = readRendition(manifest, 'archive', keys.archive);
  const review = readRendition(manifest, 'review', keys.review);

  // NEVER a loudness target on anything but the review. This is the guard mutants F1/F2/F10
  // protect on the Python side; refusing it here as well means the archive cannot be
  // mastered by a change to either half alone.
  if (raw.loudness_target_lufs !== null) throw new Error('raw must never carry a loudness target');
  if (archive.loudness_target_lufs !== null) throw new Error('archive must never carry a loudness target');
  if (review.loudness_target_lufs !== REVIEW_TARGET_LUFS) return invalidManifest();

  // The archive IS measured, and the measurements must be readable — they are simply never
  // gated. An unmeasured archive is a manifest that cannot be audited later.
  if (!isFiniteNumber(archive.integrated_lufs) || !isFiniteNumber(archive.true_peak_dbtp)) return invalidManifest();
  if (!isFiniteNumber(review.integrated_lufs) || !isFiniteNumber(review.true_peak_dbtp)) return invalidManifest();

  // The finished raw must be the object the Workflow put there. A different size or length is
  // a different recording, whatever the manifest calls it.
  if (
    raw.bytes !== call.rawSizeBytes ||
    (call.rawDurationSeconds !== null &&
      Math.abs((raw.duration_seconds as number) - call.rawDurationSeconds) > DURATION_TOLERANCE_SECONDS)
  ) {
    throw new Error('finished raw is not the object that was submitted');
  }

  for (const rendition of [archive, review]) {
    const drift = Math.abs((rendition.duration_seconds as number) - (raw.duration_seconds as number));
    if (drift > DURATION_TOLERANCE_SECONDS) throw new Error('rendition duration drifted from the raw');
  }

  if (Math.abs((review.integrated_lufs as number) - REVIEW_TARGET_LUFS) > REVIEW_TOLERANCE_LUFS) {
    throw new Error('review is off its loudness target');
  }
  if ((review.true_peak_dbtp as number) > REVIEW_MAX_TRUE_PEAK_DBTP) {
    throw new Error('review true peak exceeds the ceiling');
  }

  const shape = (name: RenditionName, rendition: Record<string, unknown>): ValidatedRendition => ({
    key: keys[name],
    contentType: CONTENT_TYPES[name],
    sizeBytes: rendition.bytes as number,
    durationSeconds: rendition.duration_seconds as number,
  });

  return { raw: shape('raw', raw), archive: shape('archive', archive), review: shape('review', review) };
};
