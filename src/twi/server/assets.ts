import { HttpError, json } from './http';
import { creationCoreCapabilities } from './capabilities';
import { systemIdentityClock, type ProjectIdentityClock } from './projects';
import type { R2BucketLike } from './r2-types';
import type { TwiRepository } from './repository';
import type { AssetRecord, RegisterAssetOutcome } from './repository-types';

/**
 * Image-reference ingestion for `/api/twi/*`.
 *
 * Phase 1 accepts up to ten image references per specification because Lyria 3 Pro
 * supports them. This module is the whole ingestion path: validate the BYTES, write
 * the object, record the row, and undo the object if the row cannot be written.
 *
 * Three properties are load-bearing, and each one is an ORDER rather than a value —
 * which is why `assets.test.ts` witnesses the order with a recording double instead
 * of asserting a comment:
 *
 *   1. THE SIZE CAP FIRES BEFORE ANY BYTE IS READ. A cap applied after the upload
 *      has been materialised is not a guard, it is an amplifier: the isolate has
 *      already paid for the memory it is about to refuse. So `validateImageReference`
 *      measures `size` first and reads only the 16-byte probe window afterwards, and
 *      `uploadImageReference` refuses an oversize declared `Content-Length` BEFORE
 *      `request.formData()` parses anything. Two independent bounds, because a
 *      streamed body carries no `Content-Length` — the same hole `parseJson`
 *      documents for JSON.
 *   2. NEITHER THE FILENAME NOR THE DECLARED CONTENT TYPE IS EVIDENCE. Both are
 *      caller-supplied strings. The extension and the stored content type are
 *      derived from the magic bytes, so `evil.php` renamed `mood.jpg` is refused and
 *      PNG bytes announced as `image/jpeg` are stored — correctly — as PNG.
 *   3. R2 IS WRITTEN BEFORE D1, AND ROLLED BACK IF D1 REFUSES. There is no
 *      transaction spanning the two. The order is chosen so the failure mode is a
 *      brief orphan object rather than a row pointing at nothing: a row whose object
 *      is absent is a broken reference the wizard cannot render, while an object
 *      whose row is absent is invisible and is deleted here anyway.
 *
 * The public shape is `AssetRecord`. The binding never leaves this module — it
 * arrives as a parameter, is used, and is not put in any response.
 */

/** Largest image reference accepted, before any of it is read. */
export const MAX_IMAGE_REFERENCE_BYTES = 10 * 1024 * 1024;

/**
 * Multipart envelope slack over the payload cap: boundary lines, the part's own
 * headers and the trailing delimiter. Same shape of allowance as `RAW_LENGTH_SLACK`
 * in src/twi/domain/schemas.ts — it exists so a legitimate 10 MiB image is not
 * refused for the bytes its envelope adds, and it is deliberately far too small to
 * let a second image through.
 */
export const MULTIPART_ENVELOPE_SLACK_BYTES = 16 * 1024;

/** The declared-body bound checked before the multipart form is parsed at all. */
export const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_REFERENCE_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES;

/**
 * How much of the upload the format check may read.
 *
 * Sixteen bytes covers every signature below with room to spare — the longest is
 * WebP's, which needs twelve — and the number is what makes property 1 above a
 * bounded read rather than a promise.
 */
export const MAGIC_BYTE_PROBE_BYTES = 16;

/**
 * Ten references per specification, taken from the capability catalog rather than
 * written again here.
 *
 * The number appears in three places — this guard, `creationCoreCapabilities`, and
 * the `boundedArray(uuid, 10)` bound on `sound.imageAssetIds` in
 * src/twi/domain/schemas.ts. Two of the three are now the same value by
 * construction; the third is asserted equal by test, because a wizard that collects
 * eleven references the schema then rejects wastes the owner's work at the last
 * step before a paid render.
 */
export const MAX_IMAGE_REFERENCES_PER_SPEC = creationCoreCapabilities.maxImageReferences;

/** Every TWI object lives under this prefix, so the bucket stays shared safely. */
export const R2_TWI_PREFIX = 'twi/';

/** The one multipart field this endpoint accepts. */
export const UPLOAD_FILE_FIELD = 'file';

const MULTIPART_CONTENT_TYPE = 'multipart/form-data';

export type ImageExtension = 'jpg' | 'png' | 'webp';

/**
 * The slice of `File` this module uses.
 *
 * Declared structurally for the same reason `D1DatabaseLike` is: a real `File` is
 * assignable to it, and a test can supply one that refuses to hand over a byte —
 * which is the only way to prove the size cap runs before the read rather than
 * beside it.
 */
export interface UploadedFileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImageReferenceDescriptor {
  extension: ImageExtension;
  /** Derived from the bytes. Never `file.type`. */
  contentType: string;
  bytes: number;
}

export interface ImageAssetDeps {
  bucket: R2BucketLike;
  repo: TwiRepository;
  clock?: ProjectIdentityClock;
}

export interface CreateImageAssetInput {
  projectId: string;
  file: UploadedFileLike;
}

export interface CreateImageAssetResult {
  asset: AssetRecord;
  outcome: RegisterAssetOutcome;
}

interface SignaturePart {
  readonly at: number;
  readonly bytes: readonly number[];
}

interface ImageSignature {
  readonly extension: ImageExtension;
  readonly contentType: string;
  readonly parts: readonly SignaturePart[];
}

/**
 * The accepted formats, as byte patterns.
 *
 * WebP needs two parts: a RIFF container header and the `WEBP` form type eight
 * bytes in. Checking only `RIFF` would accept WAV and AVI, which is why the
 * truncated-header case has a test of its own. The RIFF length field between them is
 * deliberately NOT read — a caller-supplied length is not evidence of anything.
 */
const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  { extension: 'png', contentType: 'image/png', parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  { extension: 'jpg', contentType: 'image/jpeg', parts: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  {
    extension: 'webp',
    contentType: 'image/webp',
    parts: [
      { at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
];

const matchesSignature = (head: Uint8Array, signature: ImageSignature): boolean =>
  signature.parts.every(
    (part) =>
      head.length >= part.at + part.bytes.length &&
      part.bytes.every((byte, index) => head[part.at + index] === byte),
  );

/**
 * Object-key segments are restricted rather than escaped.
 *
 * `projectId` and the minted `assetId` are both UUIDs in practice, so nothing
 * legitimate is refused — and a value containing `/` or `..` would silently move the
 * object out of its project's prefix, where the next task's per-project listing would
 * not find it and another project's would.
 */
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  // Web Crypto is present in Workers, browsers and Node 18+, and it is the same
  // primitive src/twi/server/spec-digest.ts uses for the spec fingerprint.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Decides what an upload IS, from its first bytes, and refuses everything else.
 *
 * The statement order in here is the guarantee described at the top of the file: the
 * three cheap rejections come first and the read comes last, bounded to
 * {@link MAGIC_BYTE_PROBE_BYTES}. A 100 MB upload is refused having read none of it.
 */
export async function validateImageReference(file: UploadedFileLike): Promise<ImageReferenceDescriptor> {
  const { size } = file;
  if (!Number.isInteger(size) || size < 0) {
    throw new HttpError(400, 'upload has no measurable size', 'invalid_upload');
  }
  if (size === 0) throw new HttpError(400, 'upload is empty', 'empty_upload');
  // BEFORE the read below, and that ordering is the whole point. Measuring after
  // buffering turns the cap into a memory amplifier: the isolate has already paid
  // for what it is about to refuse.
  if (size > MAX_IMAGE_REFERENCE_BYTES) {
    throw new HttpError(413, `image reference must be at most ${MAX_IMAGE_REFERENCE_BYTES} bytes`);
  }

  const head = new Uint8Array(await file.slice(0, MAGIC_BYTE_PROBE_BYTES).arrayBuffer());
  const signature = IMAGE_SIGNATURES.find((candidate) => matchesSignature(head, candidate));
  // Neither `file.name` nor `file.type` is consulted, here or anywhere below: both
  // are strings the caller chose.
  if (!signature) {
    throw new HttpError(415, 'image reference must be a JPEG, PNG or WebP image', 'unsupported_image');
  }

  return { extension: signature.extension, contentType: signature.contentType, bytes: size };
}

/**
 * Ten image references per specification.
 *
 * Exported as its own guard rather than folded into the upload path because the
 * limit is a property of a SPECIFICATION, not of a project's storage: the submit
 * path (Task 7) is where a set of references is chosen, and this is the function it
 * calls. See the known limitation recorded in the task report — the upload endpoint
 * does not cap how many references a project may accumulate, because counting them
 * needs a repository read and `src/twi/server/repository.ts` is Task 7's file.
 */
export function assertImageReferenceSelection(imageAssetIds: readonly string[]): void {
  if (imageAssetIds.length > MAX_IMAGE_REFERENCES_PER_SPEC) {
    throw new HttpError(
      400,
      `a specification may reference at most ${MAX_IMAGE_REFERENCES_PER_SPEC} images`,
      'too_many_image_references',
    );
  }
}

/** `twi/{projectId}/assets/{assetId}/source.{ext}`, with both segments checked. */
export function imageReferenceR2Key(projectId: string, assetId: string, extension: ImageExtension): string {
  for (const [field, value] of [
    ['projectId', projectId],
    ['assetId', assetId],
  ] as const) {
    if (!SAFE_KEY_SEGMENT.test(value)) {
      throw new HttpError(400, `${field} is not a usable object-key segment`, 'invalid_identifier');
    }
  }
  return `${R2_TWI_PREFIX}${projectId}/assets/${assetId}/source.${extension}`;
}

/**
 * Validates, stores the object, then records the row — and removes the object again
 * if the row is refused.
 *
 * `registerAsset` returns `{ asset, outcome }`, and the outcome is read rather than
 * discarded: a resolved promise does not mean anything was written. It is surfaced to
 * the caller so `uploadImageReference` can answer 201 for a real insert and 200 for a
 * replay, instead of reporting a creation that did not happen.
 */
export async function createImageAsset(
  input: CreateImageAssetInput,
  deps: ImageAssetDeps,
): Promise<CreateImageAssetResult> {
  const { bucket, repo, clock = systemIdentityClock } = deps;
  const descriptor = await validateImageReference(input.file);

  const assetId = clock.newId();
  const r2Key = imageReferenceR2Key(input.projectId, assetId, descriptor.extension);

  // Bounded above by the cap `validateImageReference` has already applied, so this
  // is the first and only point at which the whole upload exists in the isolate.
  const body = await input.file.arrayBuffer();
  if (body.byteLength !== descriptor.bytes) {
    // A file whose reported size disagrees with its content is either a broken
    // client or an attempt to walk past the cap by understating it.
    throw new HttpError(400, 'upload size changed while it was being read', 'invalid_upload');
  }

  const sha256 = await sha256Hex(body);
  await bucket.put(r2Key, body, { httpMetadata: { contentType: descriptor.contentType } });

  try {
    // Timestamps are minted in JS, never by SQLite: `datetime('now')` emits no
    // milliseconds and a space separator, both of which `twi_assets_created_at_iso`
    // rejects outright.
    const { asset, outcome } = await repo.registerAsset({
      id: assetId,
      projectId: input.projectId,
      jobId: null,
      kind: 'image-reference',
      label: null,
      r2Key,
      contentType: descriptor.contentType,
      bytes: descriptor.bytes,
      durationSeconds: null,
      sha256,
      provenanceKey: null,
      lifecycleState: 'active',
      createdAt: clock.now(),
      deletedAt: null,
    });
    return { asset, outcome };
  } catch (error) {
    // Compensate, then rethrow the ORIGINAL failure. A delete that also fails must
    // not replace the diagnosis with its own: the caller needs to know why the row
    // was refused, and the orphan is a storage cost, not a correctness one.
    try {
      await bucket.delete(r2Key);
    } catch (cleanupError) {
      console.error('[twi] orphaned R2 object after a failed asset insert', {
        r2Key,
        error: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
      });
    }
    throw error;
  }
}

/**
 * `POST /api/twi/projects/:projectId/assets` — one multipart `file` field.
 *
 * The dispatcher never consumes the request body, so this is the only place it is
 * read, and the two guards above the read are the ones that matter: a non-multipart
 * body and an oversize declared length are both refused before `formData()` parses a
 * byte.
 */
export async function uploadImageReference(
  request: Request,
  projectId: string,
  deps: ImageAssetDeps,
): Promise<Response> {
  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
  if (!contentType.startsWith(MULTIPART_CONTENT_TYPE)) {
    throw new HttpError(415, `upload must be sent as ${MULTIPART_CONTENT_TYPE}`);
  }

  // BEFORE request.formData(). Parsing a 100 MB multipart body to discover it is
  // too large is the defect this ordering exists to avoid; the payload cap inside
  // validateImageReference is the second bound, for a streamed body that declares
  // no length at all.
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) {
    throw new HttpError(413, 'request body too large');
  }

  // Checked before the body is touched and before anything is written: an upload
  // against a project that does not exist would otherwise leave an object in R2 and
  // surface the foreign-key refusal as internal_error.
  const project = projectId.trim().length === 0 ? null : await deps.repo.getProject(projectId);
  if (!project) throw new HttpError(404, 'project not found');

  const form = await request.formData();
  const unknownFields = [...new Set(form.keys())].filter((field) => field !== UPLOAD_FILE_FIELD);
  if (unknownFields.length > 0) {
    throw new HttpError(400, `unknown field: ${unknownFields.join(', ')}`, 'unknown_field');
  }

  // Rejected rather than resolved by picking one. Two `file` parts is an ambiguous
  // request, and answering it by silently using the first is the same defect as
  // accepting an unknown field: the owner cannot see which upload was discarded.
  const parts = form.getAll(UPLOAD_FILE_FIELD);
  if (parts.length > 1) {
    throw new HttpError(400, `multipart field \`${UPLOAD_FILE_FIELD}\` was sent ${parts.length} times`, 'duplicate_file');
  }

  const uploaded = form.get(UPLOAD_FILE_FIELD);
  if (uploaded === null) {
    throw new HttpError(400, `multipart field \`${UPLOAD_FILE_FIELD}\` is required`, 'missing_file');
  }
  if (typeof uploaded === 'string') {
    throw new HttpError(400, `multipart field \`${UPLOAD_FILE_FIELD}\` must be a file`, 'invalid_upload');
  }

  const { asset, outcome } = await createImageAsset({ projectId, file: uploaded }, deps);
  // 201 only for a write this call performed. A replayed or reconciled registration
  // is an existing asset being reported, not a creation, and saying 201 there would
  // make the outcome field the only honest part of the answer.
  return json({ asset, outcome }, outcome === 'inserted' ? 201 : 200);
}
