// ctx.exports carries loopback bindings for the ENTRYPOINT exports only, so mainModule
// names exactly those two. The module namespace cannot be used wholesale: index.ts also
// exports parseStartPayload, workflowInstanceId and START_PAYLOAD_KEYS for the tests and
// the cross-package contract check, and `Exports` demands every key it maps be an
// ExportedHandler or an entrypoint class. A default import cannot be used either -- that
// keys Exports on `fetch`/`queue` and removes the `default` handle the tests use.
import type workerDefault from './src/index';
import type { TwiRenderWorkflow } from './src/index';

declare global {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    TWI_RENDER_WORKFLOW: Workflow<import('./src/workflow').StartPayload>;
    TWI_RENDER_QUEUE: Queue;
    TWI_PROVIDER_MODE?: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }

  namespace Cloudflare {
    interface Env extends globalThis.Env {}
    interface GlobalProps {
      mainModule: { default: typeof workerDefault; TwiRenderWorkflow: typeof TwiRenderWorkflow };
    }
  }
}

export {};
