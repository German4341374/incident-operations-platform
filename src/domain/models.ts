import type { IncidentPriority, IncidentStatus } from './incident.js';

export interface Incident {
  id: string;
  incidentNumber: string;
  title: string;
  description: string;
  priority: IncidentPriority;
  status: IncidentStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  reportedBy: string;
  firstResponseDeadline: string;
  resolutionDeadline: string;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIncidentInput {
  title: string;
  description: string;
  priority: IncidentPriority;
  reportedBy: string;
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  priority?: IncidentPriority;
  status?: IncidentStatus;
  assigneeId?: string | null;
}

export interface IncidentFilters {
  status?: IncidentStatus;
  priority?: IncidentPriority;
  assigneeId?: string;
  query?: string;
  page: number;
  pageSize: number;
}
