import { describe, expect, it } from 'vitest';
import { calculateSlaDeadlines, slaPolicies } from '../../src/domain/incident.js';

describe('SLA deadline calculation', () => {
  const createdAt = new Date('2026-01-15T12:00:00.000Z');

  it.each([
    ['P1', 15, 240],
    ['P2', 60, 480],
    ['P3', 240, 1440],
    ['P4', 480, 4320],
  ] as const)(
    'calculates %s first response and resolution deadlines',
    (priority, first, resolution) => {
      const deadlines = calculateSlaDeadlines(priority, createdAt);
      expect(deadlines.firstResponseDeadline.toISOString()).toBe(
        new Date(createdAt.getTime() + first * 60_000).toISOString(),
      );
      expect(deadlines.resolutionDeadline.toISOString()).toBe(
        new Date(createdAt.getTime() + resolution * 60_000).toISOString(),
      );
    },
  );

  it('supports an accelerated development clock without changing the policy', () => {
    const deadlines = calculateSlaDeadlines('P1', createdAt, 0.001);
    expect(deadlines.firstResponseDeadline.getTime() - createdAt.getTime()).toBe(900);
    expect(deadlines.resolutionDeadline.getTime() - createdAt.getTime()).toBe(14_400);
    expect(slaPolicies.P1.resolutionMinutes).toBe(240);
  });
});
