/**
 * Structural subset of the Cloudflare service binding this layer dispatches through.
 *
 * Declared as an interface for the same reason `./d1-types` and `./r2-types` are: the
 * TWI tsconfig deliberately keeps `@cloudflare/workers-types` out of its program,
 * because those globals shadow the DOM's (see the header of tsconfig.sp1epacker.json).
 * A real service binding's `fetch(input, init?)` is assignable to {@link
 * TwiOrchestratorBinding} — its parameter types are wider — so declaring the shape
 * here costs nothing at runtime and lets the unit suites count DISPATCHES without a
 * Workers runtime or a deployed Worker.
 *
 * The init type is deliberately NARROWER than `RequestInit`. This layer sends exactly
 * one shape — a POST carrying a small JSON envelope — and a binding surface that
 * admitted a stream, a `Request` object or an `AbortSignal` would let a later task put
 * the audio, the compiled prompt or the spec bytes across this boundary without
 * anything failing. The Workflow loads what it needs from the job row; what crosses
 * here is an IDENTITY, not a payload.
 */

export interface OrchestratorRequestInit {
  method: 'POST';
  headers: Record<string, string>;
  /** A JSON envelope. Small by construction: ids, a digest and the estimate. */
  body: string;
}

export interface TwiOrchestratorBinding {
  fetch(input: string, init: OrchestratorRequestInit): Promise<Response>;
}
