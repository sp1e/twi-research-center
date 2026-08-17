import type { D1DatabaseLike } from './d1-types';

/**
 * The bindings the TWI Pages Function consumes.
 *
 * `DB` is typed as {@link D1DatabaseLike} rather than Cloudflare's `D1Database`
 * for the same reason the repository is — see the header of `./d1-types`. A real
 * binding is assignable to it, and the unit suites can drive the whole route
 * table without Workers globals.
 *
 * Deliberately minimal. Creation Core Phase 1 only reads and writes project
 * metadata, so R2 (`FILES`) and the Workflow service binding are not declared
 * here yet: an unused binding in this interface reads as a promise that the
 * function already handles assets or job dispatch, and it does not.
 */
export interface TwiEnv {
  DB: D1DatabaseLike;
}
