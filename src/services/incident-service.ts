import { calculateSlaDeadlines } from '../domain/incident.js';
import type {
  CreateIncidentInput,
  IncidentFilters,
  UpdateIncidentInput,
} from '../domain/models.js';
import type { OutboxDispatcherPort } from '../queue/escalation-queue.js';
import type { IncidentRepository } from '../repositories/incident-repository.js';

export class IncidentService {
  constructor(
    private readonly repository: IncidentRepository,
    private readonly dispatcher: OutboxDispatcherPort,
    private readonly slaTimeFactor: number,
  ) {}

  async create(input: CreateIncidentInput, actor: string, requestId: string) {
    const deadlines = calculateSlaDeadlines(input.priority, new Date(), this.slaTimeFactor);
    const incident = await this.repository.create(input, deadlines, actor, requestId);
    void this.dispatcher.flushOnce().catch(() => 0);
    return incident;
  }

  list(filters: IncidentFilters) {
    return this.repository.list(filters);
  }

  async detail(id: string) {
    const incident = await this.repository.requireById(id);
    const related = await this.repository.related(id);
    return { incident, related };
  }

  update(
    id: string,
    expectedVersion: number,
    input: UpdateIncidentInput,
    actor: string,
    requestId: string,
  ) {
    return this.repository.update(id, expectedVersion, input, actor, requestId, this.slaTimeFactor);
  }
}
