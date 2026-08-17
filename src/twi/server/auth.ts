import type { TwiEnv } from './env';
import { getCookie, HttpError } from './http';

/**
 * The owner gate for `/api/twi/*`.
 *
 * TWI is a private single-owner studio: there is no TWI account system, and there
 * is not meant to be one. The credential is the site session the owner already
 * holds — the same `session` cookie and the same lookup as `requireAuth` in
 * `functions/api/[[route]].ts`. Reusing it means logging out of SP1E logs out of
 * the studio, and it means there is exactly one session store to reason about.
 *
 * Two details are load-bearing:
 *
 *   * `datetime('now')` is correct HERE and forbidden elsewhere in this layer.
 *     `sessions.expires_at` is written by the site's login handler as
 *     `Date#toISOString()` and read by the site's own gate with this predicate;
 *     the TWI tables are the ones whose CHECK constraints reject SQL-generated
 *     timestamps. Do not "fix" this line to match them — it would stop agreeing
 *     with the rows the login handler actually writes.
 *
 *   * The failure is always the same opaque 401. Distinguishing "no cookie" from
 *     "expired" from "unknown token" would tell an unauthenticated caller which
 *     half of a guess was right.
 */
export async function requireOwnerSession(request: Request, env: Pick<TwiEnv, 'DB'>): Promise<void> {
  const token = getCookie(request, 'session');
  // Short-circuits before any statement is prepared: an anonymous flood of
  // requests must not become a flood of D1 reads.
  if (!token) throw new HttpError(401, 'Unauthorized');

  const row = await env.DB.prepare(
    `SELECT token FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')`,
  )
    .bind(token)
    .first();

  if (!row) throw new HttpError(401, 'Unauthorized');
}
