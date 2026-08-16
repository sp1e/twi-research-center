import type { JobStatus } from './types';

const transitions: Record<JobStatus, readonly JobStatus[]> = {
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

export const isTerminal = (status: JobStatus): boolean => ['complete', 'cancelled', 'error'].includes(status);

export const canTransition = (from: JobStatus, to: JobStatus): boolean => transitions[from].includes(to);

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal TWI job transition: ${from} → ${to}`);
  }
}
