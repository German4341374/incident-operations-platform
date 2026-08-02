import type { EscalationType } from '../domain/incident.js';

export function escalationIdempotencyKey(
  incidentId: string,
  escalationType: EscalationType,
  deadline: Date | string,
): string {
  const timestamp = new Date(deadline).getTime();
  return `escalation--${incidentId}--${escalationType}--${timestamp}`;
}
