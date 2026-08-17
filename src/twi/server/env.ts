import type { D1DatabaseLike } from './d1-types';
import type { R2BucketLike } from './r2-types';

/**
 * The bindings the TWI Pages Function consumes.
 *
 * `DB` and `FILES` are typed as {@link D1DatabaseLike} / {@link R2BucketLike}
 * rather than Cloudflare's `D1Database` / `R2Bucket` for the same reason the
 * repository is — see the header of `./d1-types`. A real binding is assignable to
 * either, and the unit suites can drive the whole route table without Workers
 * globals.
 *
 * Still deliberately minimal, and the rule behind that has not changed: a binding
 * declared here reads as a promise that the function handles what the binding is
 * for, so it is declared when the promise becomes true and not before.
 *
 * `FILES` became true in Task 6. It is the EXISTING bucket `wrangler.toml` already
 * declares (`binding = "FILES"`, `bucket_name = "sp1e-files"`, shared with the Stem
 * Lab) rather than a new one; `src/twi/server/assets.ts` writes every TWI object
 * under the `twi/` key prefix so the two cannot collide. The Workflow service
 * binding is still absent, because nothing here dispatches a job yet — that is
 * Task 7.
 */
export interface TwiEnv {
  DB: D1DatabaseLike;
  FILES: R2BucketLike;
}
