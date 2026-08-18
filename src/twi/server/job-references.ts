import { creationCoreCapabilities } from './capabilities';
import { HttpError } from './http';
import type { TwiRepository } from './repository';

/**
 * What a specification is allowed to reference, checked before anything is paid for.
 *
 * The ten-per-specification CAP is NOT here. It lives in `./jobs`, applied to the raw
 * request ahead of the schema parse, and that placement is deliberate: `boundedArray(uuid,
 * 10)` already refuses an eleventh entry inside `submitJobSchema`, so a cap applied to the
 * PARSED list could never fire. A guard that cannot fire is what Task 6 accidentally
 * shipped — `assertImageReferenceSelection` had no production caller at all — and moving it
 * here would have reproduced that in a new place.
 *
 * What this module owns is the per-project verification, and the order of its checks is the
 * guarantee rather than an accident:
 *
 *   1. DISTINCTNESS, from the request alone — no query, nothing to pay for. It comes first
 *      because the counts below compare against `imageAssetIds.length`, and a list naming
 *      one asset twice would otherwise be reported as a missing reference.
 *   2. MEMBERSHIP. One counting query over at most ten ids. This is the per-project
 *      reference count the ingestion path could not perform, because counting needs a
 *      repository read and `repository.ts` was not Task 6's file.
 *   3. CAPABILITY. A second count, narrowed to `kind = 'image-reference'`. Two counts
 *      rather than one because the two failures are different verdicts the owner needs to
 *      tell apart: an id that is not in this project is a MISTAKE, while an id that IS in
 *      this project but names audio is a CAPABILITY the provider does not have
 *      (`creationCoreCapabilities.audioReference` is false, and Phase 1 explains that
 *      instead of silently dropping the input).
 *
 * Only `lifecycle_state = 'active'` counts. A deleted or still-provisional asset has no
 * bytes the render can rely on, so it is refused here rather than becoming a broken
 * reference the paid provider is handed.
 */

const unavailableKinds = (): string =>
  [
    creationCoreCapabilities.audioReference ? null : 'audio',
    creationCoreCapabilities.midiReference ? null : 'MIDI',
  ]
    .filter((kind): kind is string => kind !== null)
    .join(' and ');

export async function assertImageReferencesUsable(
  projectId: string,
  imageAssetIds: readonly string[],
  repo: TwiRepository,
): Promise<void> {
  // 1. Free, and therefore first.
  if (new Set(imageAssetIds).size !== imageAssetIds.length) {
    throw new HttpError(
      400,
      'image references must be distinct',
      'duplicate_image_reference',
    );
  }
  if (imageAssetIds.length === 0) return;

  // 2. Membership, as a count over the project's own rows.
  const owned = await repo.countProjectAssets({ projectId, assetIds: imageAssetIds, kind: null });
  if (owned !== imageAssetIds.length) {
    throw new HttpError(
      400,
      'every image reference must be an active asset of this project',
      'unknown_image_reference',
    );
  }

  // 3. Capability. Narrowed to the one kind this provider accepts.
  const images = await repo.countProjectAssets({ projectId, assetIds: imageAssetIds, kind: 'image-reference' });
  if (images !== imageAssetIds.length) {
    throw new HttpError(
      400,
      `${creationCoreCapabilities.provider} accepts image references only — ${unavailableKinds()} reference is unavailable`,
      'unsupported_capability',
    );
  }
}
