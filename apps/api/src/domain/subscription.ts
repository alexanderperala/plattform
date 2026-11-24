import type { SubscriptionStatus } from './access.js';
import { conflict } from '../lib/errors.js';

// Tillåtna övergångar (avsnitt 4.2)
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  Trialing: ['Active', 'Expired', 'Paused'],
  Active: ['PastDue', 'Paused', 'CanceledAtPeriodEnd', 'Expired'],
  PastDue: ['Active', 'Paused', 'Expired'],
  Paused: ['Active', 'Expired'],
  CanceledAtPeriodEnd: ['Active', 'Expired'],
  Expired: ['Active', 'Trialing'],
};

export const canTransition = (from: SubscriptionStatus, to: SubscriptionStatus): boolean =>
  SUBSCRIPTION_TRANSITIONS[from].includes(to);

export function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransition(from, to)) {
    throw conflict('INVALID_TRANSITION', `Abonnemanget kan inte gå från ${from} till ${to}.`, { from, to });
  }
}

export const WORKSPACE_TRANSITIONS = {
  Active: ['Suspended', 'Closed'],
  Suspended: ['Active', 'Closed'],
  Closed: ['Active'],
} as const;

export const CASE_TRANSITIONS: Record<string, string[]> = {
  New: ['InProgress'],
  InProgress: ['WaitingCustomer', 'WaitingInternal', 'Resolved'],
  WaitingCustomer: ['InProgress', 'Resolved'],
  WaitingInternal: ['InProgress', 'Resolved'],
  Resolved: ['Closed', 'InProgress'],
  Closed: ['InProgress'],
};
