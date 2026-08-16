import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, isTerminal } from './job-state';
import type { JobStatus } from './types';

const expectedTransitions: Record<JobStatus, readonly JobStatus[]> = {
  draft: ['estimated'],
  estimated: ['queued'],
  queued: ['generating', 'cancelling', 'error'],
  generating: ['ingesting', 'cancelling', 'error'],
  ingesting: ['finishing', 'cancelling', 'error'],
  finishing: ['validating', 'cancelling', 'error'],
  validating: ['complete', 'error'],
  complete: [],
  cancelling: ['cancelled', 'complete', 'error'],
  cancelled: [],
  error: ['retrying'],
  retrying: ['queued', 'generating', 'ingesting', 'finishing', 'validating', 'error'],
};

const statuses = Object.keys(expectedTransitions) as JobStatus[];

describe('TWI job state machine', () => {
  it('allows the required forward, cancellation, and retry transitions', () => {
    expect(canTransition('queued', 'generating')).toBe(true);
    expect(canTransition('generating', 'cancelling')).toBe(true);
    expect(canTransition('error', 'retrying')).toBe(true);
    expect(canTransition('complete', 'generating')).toBe(false);
  });

  it('declares an exact transition entry for every job status', () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expectedTransitions[from].includes(to));
      }
    }
  });

  it('reports complete, cancelled, and error as terminal outcomes', () => {
    for (const status of statuses) {
      expect(isTerminal(status), status).toBe(['complete', 'cancelled', 'error'].includes(status));
    }
  });

  it('supports cancellation only from active work and all cancellation outcomes', () => {
    for (const status of ['queued', 'generating', 'ingesting', 'finishing'] as const) {
      expect(canTransition(status, 'cancelling'), status).toBe(true);
    }

    expect(canTransition('validating', 'cancelling')).toBe(false);
    expect(canTransition('cancelling', 'cancelled')).toBe(true);
    expect(canTransition('cancelling', 'complete')).toBe(true);
    expect(canTransition('cancelling', 'error')).toBe(true);
  });

  it('allows retry checkpoints to re-enter only durable work phases', () => {
    const retryTargets: JobStatus[] = ['queued', 'generating', 'ingesting', 'finishing', 'validating', 'error'];

    for (const status of statuses) {
      expect(canTransition('retrying', status), status).toBe(retryTargets.includes(status));
    }
  });

  it('forbids every self-transition', () => {
    for (const status of statuses) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it('throws an actionable error for an illegal transition', () => {
    expect(() => assertTransition('complete', 'error')).toThrow('complete → error');
  });
});
