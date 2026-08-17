// @vitest-environment node
/// <reference types="node" />
//
// The owner gate. TWI is a private single-owner studio, so this one function is
// the entire authorization boundary for /api/twi/*. Both doubles are used on
// purpose: ScriptedD1 proves WHAT is asked of the database (and that nothing is
// asked when there is no cookie), SqliteD1 proves the answer is right against a
// real `sessions` table.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireOwnerSession } from './auth';
import { ScriptedD1, SqliteD1, rows } from './repository.harness';

const SESSIONS_TABLE = `CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
)`;

const request = (cookie?: string) =>
  new Request('https://sp1e.se/api/twi/bootstrap', cookie ? { headers: { Cookie: cookie } } : undefined);

describe('requireOwnerSession against a real sessions table', () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = new SqliteD1();
    db.exec(SESSIONS_TABLE);
  });

  afterEach(() => db.close());

  const insertSession = (token: string, expiresAt: Date) =>
    db.exec('INSERT INTO sessions (token, expires_at) VALUES (?, ?)', token, expiresAt.toISOString());

  it('accepts an unexpired session token', async () => {
    insertSession('live-token', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    await expect(requireOwnerSession(request('session=live-token'), { DB: db })).resolves.toBeUndefined();
  });

  it('rejects an EXPIRED session token', async () => {
    // A gate that only checks the cookie's presence, or forgets the expiry
    // predicate, passes every other test in this file and fails only this one.
    insertSession('stale-token', new Date(Date.now() - 60 * 1000));

    await expect(requireOwnerSession(request('session=stale-token'), { DB: db })).rejects.toThrowError(
      expect.objectContaining({ status: 401, message: 'Unauthorized' }),
    );
  });

  it('rejects a token that is not in the table', async () => {
    insertSession('live-token', new Date(Date.now() + 60_000));

    await expect(requireOwnerSession(request('session=forged'), { DB: db })).rejects.toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('does not accept the Fredagsfett cookie as an owner session', async () => {
    insertSession('live-token', new Date(Date.now() + 60_000));

    await expect(requireOwnerSession(request('ff_session=live-token'), { DB: db })).rejects.toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });
});

describe('requireOwnerSession statement shape', () => {
  it('never touches the database when no session cookie is present', async () => {
    const db = new ScriptedD1();

    await expect(requireOwnerSession(request(), { DB: db })).rejects.toThrowError(
      expect.objectContaining({ status: 401, message: 'Unauthorized' }),
    );
    expect(db.statements).toEqual([]);
  });

  it('never touches the database for a valueless session cookie either', async () => {
    // `Cookie: session=` yields '' rather than null, so a gate written
    // `token === null` would hand the empty string to D1 and pay a round trip per
    // request for it — the anonymous-flood hazard the short-circuit exists to
    // stop, reopened by a cookie any client can send. `!token` covers both.
    const db = new ScriptedD1();

    await expect(requireOwnerSession(request('session='), { DB: db })).rejects.toThrowError(
      expect.objectContaining({ status: 401, message: 'Unauthorized' }),
    );
    expect(db.statements).toEqual([]);
  });

  it('looks the token up by binding it, never by interpolating it into SQL', async () => {
    const db = new ScriptedD1();
    db.firstResults.push({ token: 'live-token' });

    await requireOwnerSession(request("session=live-token' OR '1'='1"), { DB: db });

    expect(db.statements).toHaveLength(1);
    const [statement] = db.statements;
    expect(statement?.sql.replace(/\s+/g, ' ')).toContain(
      "FROM sessions WHERE token = ? AND datetime(expires_at) > datetime('now')",
    );
    expect(statement?.bindings).toEqual(["live-token' OR '1'='1"]);
  });

  it('reads a single row rather than listing the sessions table', async () => {
    const db = new ScriptedD1();
    // `first()` is scripted; `all()` is not. A rewrite to `.all()` throws here
    // instead of quietly loading every session row into the isolate.
    db.firstResults.push({ token: 'live-token' });
    db.allResults.push(rows([{ token: 'live-token' }]));

    await requireOwnerSession(request('session=live-token'), { DB: db });

    expect(db.allResults).toHaveLength(1);
  });
});
