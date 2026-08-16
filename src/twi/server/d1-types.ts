/**
 * Structural subset of the Cloudflare D1 driver that this layer depends on.
 *
 * The repository is written against these shapes rather than `D1Database` so the
 * unit suites can drive it without Workers globals. A real `D1Database` from
 * `@cloudflare/workers-types` is assignable to `D1DatabaseLike`; the miniflare
 * suite (`repository-d1.test.ts`) pins that assignability against a live binding.
 */

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: true;
  error?: never;
  meta: {
    changes: number;
    [key: string]: unknown;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

export interface TwiRepositoryEnv {
  DB: D1DatabaseLike;
}
