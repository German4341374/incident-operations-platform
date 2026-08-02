export const incidentStatuses = [
  'Open',
  'Investigating',
  'Mitigating',
  'Monitoring',
  'Resolved',
  'Closed',
] as const;

export const incidentPriorities = ['P1', 'P2', 'P3', 'P4'] as const;

export type IncidentStatus = (typeof incidentStatuses)[number];
export type IncidentPriority = (typeof incidentPriorities)[number];
export type EscalationType = 'first_response' | 'resolution';

export interface SlaPolicy {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface SlaDeadlines {
  firstResponseDeadline: Date;
  resolutionDeadline: Date;
}

export const slaPolicies: Record<IncidentPriority, SlaPolicy> = {
  P1: { firstResponseMinutes: 15, resolutionMinutes: 4 * 60 },
  P2: { firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
  P3: { firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  P4: { firstResponseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
};

const transitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  Open: ['Investigating', 'Resolved'],
  Investigating: ['Mitigating', 'Monitoring', 'Resolved'],
  Mitigating: ['Monitoring', 'Resolved'],
  Monitoring: ['Mitigating', 'Resolved'],
  Resolved: ['Monitoring', 'Closed'],
  Closed: [],
};

export function calculateSlaDeadlines(
  priority: IncidentPriority,
  createdAt = new Date(),
  timeFactor = 1,
): SlaDeadlines {
  const policy = slaPolicies[priority];
  const minuteMs = 60_000 * timeFactor;
  return {
    firstResponseDeadline: new Date(createdAt.getTime() + policy.firstResponseMinutes * minuteMs),
    resolutionDeadline: new Date(createdAt.getTime() + policy.resolutionMinutes * minuteMs),
  };
}

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function assertTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: IncidentStatus,
    public readonly to: IncidentStatus,
  ) {
    super(`Incident cannot transition from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
