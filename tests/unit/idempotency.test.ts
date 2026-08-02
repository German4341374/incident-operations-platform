import { describe, expect, it } from 'vitest';
import { escalationIdempotencyKey } from '../../src/queue/idempotency.js';

describe('escalation idempotency key', () => {
  it('is deterministic for the same logical job', () => {
    const deadline = '2026-02-01T10:00:00.000Z';
    expect(escalationIdempotencyKey('incident-1', 'resolution', deadline)).toBe(
      escalationIdempotencyKey('incident-1', 'resolution', new Date(deadline)),
    );
  });

  it('changes when the escalation type changes', () => {
    const deadline = '2026-02-01T10:00:00.000Z';
    expect(escalationIdempotencyKey('incident-1', 'resolution', deadline)).not.toBe(
      escalationIdempotencyKey('incident-1', 'first_response', deadline),
    );
  });

  it('changes when a reprioritization creates a new deadline', () => {
    expect(escalationIdempotencyKey('incident-1', 'resolution', '2026-02-01T10:00:00Z')).not.toBe(
      escalationIdempotencyKey('incident-1', 'resolution', '2026-02-01T11:00:00Z'),
    );
  });

  it('does not contain BullMQ-reserved colons', () => {
    expect(escalationIdempotencyKey('abc', 'resolution', '2026-02-01T10:00:00Z')).not.toContain(
      ':',
    );
  });
});
