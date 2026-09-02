/*
 * What `/callback/modal` must satisfy BEFORE it is allowed to call `sendEvent`.
 *
 * These predicates live here, pure and separately testable, for the reason section 15 of
 * scripts/twi-contract-check.mjs records: a guard that only ever runs on the happy path is
 * indistinguishable from no guard at all. The happy path presents a valid secret, a fresh
 * timestamp and two distinct tokens, so an integration suite can never forge the states
 * these refuse. As functions, a unit test can.
 *
 * Authentication here is deliberately NOT the whole story. The route proves the caller holds
 * the shared secret and is not replaying; the WORKFLOW then proves the callback answers the
 * exact call it is waiting on (`assertCallbackBindsCall` in ./manifest). Splitting it that way
 * is what lets the route stay stateless while publication still refuses a callback that names
 * the wrong call.
 */

/** How far a callback's own timestamp may sit from ours before it is treated as a replay. */
export const CALLBACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Exactly the shape every timestamp in this project is written in: JS `toISOString()`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/*
 * Opaque tokens are UUID-shaped in practice, but the check is a character class and a length
 * band rather than a UUID pattern: the token is Modal's to echo, and pinning it to a UUID
 * would couple this route to how the Workflow happens to mint one today. What matters is that
 * it is long enough not to be guessed, short enough not to be a payload, and made only of
 * characters that cannot carry structure into anything downstream.
 */
const TOKEN_CHARACTERS = /^[A-Za-z0-9_-]+$/;
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 128;

export const isOpaqueToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= MIN_TOKEN_LENGTH &&
  value.length <= MAX_TOKEN_LENGTH &&
  TOKEN_CHARACTERS.test(value);

/*
 * Length-independent comparison. An early return on the first differing byte leaks the shared
 * secret one character at a time to anyone who can time the route, and the secret is the only
 * thing standing between an attacker and `sendEvent`. A blank expected secret NEVER matches:
 * a deployment that forgot to configure one must refuse everything, not accept everything.
 */
export const secretsMatch = (presented: string | null | undefined, expected: string): boolean => {
  if (expected.length === 0 || typeof presented !== 'string') return false;
  const at = (value: string, index: number): number => (index < value.length ? value.charCodeAt(index) : 0);
  let difference = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= at(presented, index) ^ at(expected, index);
  }
  return difference === 0;
};

export const isFreshCallbackTimestamp = (value: unknown, nowMs: number): boolean => {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(nowMs - parsed) <= CALLBACK_REPLAY_WINDOW_MS;
};

export interface CallbackAuthClaim {
  presentedSecret: string | null | undefined;
  expectedSecret: string;
  timestamp: unknown;
  nonce: unknown;
  callbackId: unknown;
  now: number;
}

/**
 * Refuses with a CODE rather than a description. The route answers 401 with that code and
 * nothing else: a caller who does not hold the secret learns whether it was the secret, the
 * clock or the tokens only if we tell them, and there is no reason to.
 */
export const assertCallbackAuthentic = ({
  presentedSecret,
  expectedSecret,
  timestamp,
  nonce,
  callbackId,
  now,
}: CallbackAuthClaim): void => {
  if (!secretsMatch(presentedSecret, expectedSecret)) throw new Error('callback_unauthorized');
  if (!isFreshCallbackTimestamp(timestamp, now)) throw new Error('callback_stale');
  // Two DISTINCT tokens. One that is a copy of the other is one token wearing two names, and
  // the pair exists so that replay refusal (the id) and per-call proof (the nonce) are
  // independent facts.
  if (!isOpaqueToken(nonce) || !isOpaqueToken(callbackId) || nonce === callbackId) {
    throw new Error('callback_unidentified');
  }
};
