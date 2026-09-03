import type { CandidateLabel } from './providers/types';

/**
 * The vocabulary a candidate's step results are written in: where its objects live in R2, what
 * its asset rows are called, and the manifest shape that crosses a Workflow step boundary.
 *
 * Extracted from workflow.ts so that `generate-step.ts` (which produces a raw candidate) and
 * the Workflow (which finishes and publishes it) name the same keys without one importing the
 * other's runtime.
 */

/** The identity a candidate's keys are derived from — the three payload fields, and nothing else. */
export interface CandidateIdentity {
  jobId: string;
  projectId: string;
  attempt: number;
}

export interface ObjectManifest {
  id: string;
  key: string;
  contentType: string;
  /**
   * The SIZE of the object, never its content. Named `sizeBytes` rather than `bytes`
   * because a Workflow step result is durable state that crosses a step boundary, and a
   * field called `bytes` is one careless edit away from carrying the audio itself. The
   * integration test forbids the NAME on a step result for exactly that reason, and
   * backs it with a 1 KiB ceiling on the serialized manifest.
   */
  sizeBytes: number;
  sha256: string;
  durationSeconds: number | null;
}

export interface RawCandidateManifest extends ObjectManifest {
  label: CandidateLabel;
  provider: string;
  model: string;
  providerCostUsd: number;
  providerRequestId: string;
  provenanceKey: string;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const objectPrefix = (payload: CandidateIdentity, label: CandidateLabel): string =>
  `twi/${payload.projectId}/jobs/${payload.jobId}/attempt-${payload.attempt}/${label}`;

export const assetId = (payload: CandidateIdentity, label: CandidateLabel, kind: string): string =>
  `${payload.jobId}:${payload.attempt}:${label}:${kind}`;
