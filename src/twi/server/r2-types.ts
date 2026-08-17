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
 * object and, when the metadata insert fails, removes the one it just wrote. It
 * never lists, never signs a URL and never hands the binding to a caller, so
 * nothing else belongs in the surface this layer can reach.
 */

/** What `put` accepts. Narrower than R2's real union — this layer only ever passes bytes. */
export type R2PutValue = ArrayBuffer | ArrayBufferView | string | null;

export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
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
