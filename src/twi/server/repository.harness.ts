/// <reference types="node" />
//
// Test doubles for the D1 driver. Two of them, deliberately:
//
//  * `ScriptedD1`  — records SQL/bindings and returns canned results. Fast, and
//    the only way to assert on statement shape and binding order.
//  * `SqliteD1`    — a real in-memory `node:sqlite` database loading the actual
//    migration, with deterministic race injection. Proves behaviour.
//
// Neither can prove that Cloudflare D1's own `batch()` gives statement N a view
// of statement N-1's `changes()`; `repository-d1.test.ts` does that against a
// workerd-backed binding.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, StatementSync } from 'node:sqlite';

import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from './d1-types';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export const MIGRATION_URL = new URL('../../../twi-migration-001-creation-core.sql', import.meta.url);

export const readMigrationSql = (): string => readFileSync(MIGRATION_URL, 'utf8');

export interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

export const changed = (changes: number): D1ResultLike<Record<string, unknown>> => ({
  success: true,
  results: [],
  meta: { changes },
});

export const rows = <T extends Record<string, unknown>>(results: T[]): D1ResultLike<T> => ({
  success: true,
  results,
  meta: { changes: 0 },
});

class ScriptedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: ScriptedD1,
    readonly record: RecordedStatement,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.record.bindings = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.db.take('firstResults', this.record.sql) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.db.take('allResults', this.record.sql) as D1ResultLike<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return this.db.take('runResults', this.record.sql) as D1ResultLike<T>;
  }
}

/**
 * Fails closed. An unscripted call throws instead of returning a cheerful
 * default, so a test that forgets to script a result — or production code that
 * issues an extra statement nobody expected — cannot pass down the success path.
 */
export class ScriptedD1 implements D1DatabaseLike {
  readonly statements: RecordedStatement[] = [];
  readonly batches: RecordedStatement[][] = [];
  readonly firstResults: Array<Record<string, unknown> | null> = [];
  readonly allResults: D1ResultLike<Record<string, unknown>>[] = [];
  readonly runResults: D1ResultLike<Record<string, unknown>>[] = [];
  readonly batchResults: D1ResultLike<Record<string, unknown>>[][] = [];

  prepare(sql: string): D1PreparedStatementLike {
    const record = { sql, bindings: [] };
    this.statements.push(record);
    return new ScriptedStatement(this, record);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.batches.push(statements.map((statement) => (statement as ScriptedStatement).record));
    if (this.batchResults.length === 0) {
      throw new Error(`unscripted DB call: batch of ${statements.length} statement(s)`);
    }
    return this.batchResults.shift() as D1ResultLike<T>[];
  }

  take(queue: 'firstResults' | 'allResults' | 'runResults', sql: string): unknown {
    const pending = this[queue];
    if (pending.length === 0) {
      throw new Error(`unscripted DB call: ${queue} for ${sql.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
    }
    return pending.shift();
  }

  /** Asserts every scripted result was consumed. */
  drained(): boolean {
    return (
      this.firstResults.length === 0 &&
      this.allResults.length === 0 &&
      this.runResults.length === 0 &&
      this.batchResults.length === 0
    );
  }
}

class SqliteD1Statement implements D1PreparedStatementLike {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.bindings = values as SQLInputValue[];
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.statement().get(...this.bindings) as T | undefined;
    return row ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const results = this.statement().all(...this.bindings) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    this.owner.runBeforeStandaloneStatement();
    return this.runSync<T>();
  }

  runSync<T = Record<string, unknown>>(): D1ResultLike<T> {
    const result = this.statement().run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.sql);
  }
}

export class SqliteD1 implements D1DatabaseLike {
  readonly database: DatabaseSyncType = new DatabaseSync(':memory:');
  beforeNextBatch: (() => void) | null = null;
  beforeNextStandaloneRun: (() => void) | null = null;

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(readMigrationSql());
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1Statement(this, sql);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => (statement as SqliteD1Statement).runSync<T>());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string, ...values: SQLInputValue[]): void {
    this.database.prepare(sql).run(...values);
  }

  runBeforeStandaloneStatement(): void {
    const beforeRun = this.beforeNextStandaloneRun;
    this.beforeNextStandaloneRun = null;
    beforeRun?.();
  }

  value<T>(sql: string, ...values: SQLInputValue[]): T {
    const row = this.database.prepare(sql).get(...values) as Record<string, T> | undefined;
    if (!row) throw new Error(`test query returned no row: ${sql}`);
    return Object.values(row)[0] as T;
  }

  close(): void {
    this.database.close();
  }
}
