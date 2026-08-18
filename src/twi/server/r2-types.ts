/**
 * Structural subset of the Cloudflare R2 binding that this layer depends on.
 *
 * Written as an interface for exactly the reason `./d1-types` is: the TWI tsconfig
 * deliberately keeps `@cloudflare/workers-types` out of its program, because those
 * globals shadow the DOM's (see the header of tsconfig.sp1epacker.json). A real
 * `R2Bucket` is assignable to {@link R2BucketLike} — it has both methods with wider
 * parameter types and a wider return — so declaring the shape here costs nothing at
 * runtime and lets the unit suites drive the whole ingestion path without a Workers
 * runtime or a live bucket.
 *
 * Only `put` and `delete` are declared, and that is the point: `assets.ts` writes an
 * object and, when the metadata insert fails, removes the one it just wrote — provided
 * no committed row names it. It never lists, never signs a URL and never hands the
 * binding to a caller, so nothing else belongs in the surface this layer can reach.
 * Notably `head` and `get` are still absent: "does an object exist here" is answered by
 * the conditional put below rather than by a second round trip that would be racy anyway.
 */

/** What `put` accepts. Narrower than R2's real union — this layer only ever passes bytes. */
export type R2PutValue = ArrayBuffer | ArrayBufferView | string | null;

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  /**
   * A PRECONDITION on the write, not a hint.
   *
   * `etagDoesNotMatch: '*'` is `If-None-Match: *` — store this object only if nothing is
   * stored under the key already. `assets.ts` needs it because the object key is derived
   * from the client's idempotency key, so two concurrent writers of one key aim at ONE
   * key: without a precondition the second put silently overwrites the first, and the
   * first writer's committed row then records a `sha256` and a `bytes` that describe
   * bytes no longer there.
   *
   * The real binding can express this, and the null return is what reports the refusal:
   * `@cloudflare/workers-types` 4.20260702.1 declares `put` twice —
   * `put(key, value, options & { onlyIf }): Promise<R2Object | null>` and
   * `put(key, value, options?): Promise<R2Object>`. The conditional overload is the ONLY
   * one whose result is nullable, so `null` from a conditional put means exactly and only
   * "the precondition failed", never "no object was written for some other reason".
   * Whether the deployed bucket honours the precondition is a deploy-time fact of the
   * same class as the four in `HANDOVER.md` §8; if a runtime ignored it, the put would
   * return an object and the behaviour would be the pre-fix behaviour, not something new.
   */
  onlyIf?: { etagDoesNotMatch?: string };
}

/**
 * The handful of fields a stored object reports back. Deliberately not returned to
 * any HTTP caller: `AssetRecord` is the public shape, and it is built from what this
 * layer already knows rather than from the binding's reply.
 */
export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
}

export interface R2BucketLike {
  put(key: string, value: R2PutValue, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
}
