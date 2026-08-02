import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  incidentStatuses,
  InvalidTransitionError,
} from '../../src/domain/incident.js';

describe('incident state machine', () => {
  it.each([
    ['Open', 'Investigating'],
    ['Investigating', 'Mitigating'],
    ['Mitigating', 'Monitoring'],
    ['Monitoring', 'Resolved'],
    ['Resolved', 'Closed'],
    ['Resolved', 'Monitoring'],
  ] as const)('allows %s to transition to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ['Open', 'Closed'],
    ['Mitigating', 'Open'],
    ['Monitoring', 'Investigating'],
    ['Closed', 'Open'],
  ] as const)('rejects %s to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it.each(incidentStatuses)('allows idempotent %s updates', (status) => {
    expect(canTransition(status, status)).toBe(true);
  });

  it('provides the source and target in transition errors', () => {
    try {
      assertTransition('Closed', 'Investigating');
      throw new Error('Expected transition to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect(error).toMatchObject({ from: 'Closed', to: 'Investigating' });
    }
  });
});
