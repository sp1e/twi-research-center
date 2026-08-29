import type worker from './src/index';

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
      mainModule: typeof worker;
    }
  }
}

export {};
