import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { calculateSlaDeadlines, assertTransition } from '../domain/incident.js';
import type { SlaDeadlines } from '../domain/incident.js';
import type {
  CreateIncidentInput,
  Incident,
  IncidentFilters,
  UpdateIncidentInput,
} from '../domain/models.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { escalationIdempotencyKey } from '../queue/idempotency.js';

interface IncidentRow extends QueryResultRow {
  id: string;
  incident_number: string;
  title: string;
  description: string;
  priority: Incident['priority'];
  status: Incident['status'];
  assignee_id: string | null;
  assignee_name: string | null;
  reported_by: string;
  first_response_deadline: Date;
  resolution_deadline: Date;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface CountedIncidentRow extends IncidentRow {
  total_count: string;
}

interface TimelineRow extends QueryResultRow {
  id: string;
  event_type: string;
  actor: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

interface AuditRow extends QueryResultRow {
  id: string;
  action: string;
  actor: string;
  previous_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  request_id: string;
  created_at: Date;
}

interface EngineerRow extends QueryResultRow {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

const incidentSelect = `
  SELECT i.id, i.incident_number, i.title, i.description, i.priority, i.status,
         i.assignee_id, e.name AS assignee_name, i.reported_by,
         i.first_response_deadline, i.resolution_deadline, i.first_responded_at,
         i.resolved_at, i.closed_at, i.version, i.created_at, i.updated_at
    FROM incidents i
    LEFT JOIN engineers e ON e.id = i.assignee_id
`;

function mapIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    incidentNumber: row.incident_number,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    reportedBy: row.reported_by,
    firstResponseDeadline: row.first_response_deadline.toISOString(),
    resolutionDeadline: row.resolution_deadline.toISOString(),
    firstRespondedAt: row.first_responded_at?.toISOString() ?? null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class IncidentRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    input: CreateIncidentInput,
    deadlines: SlaDeadlines,
    actor: string,
    requestId: string,
  ): Promise<Incident> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<IncidentRow>(
        `INSERT INTO incidents (
           title, description, priority, reported_by, first_response_deadline, resolution_deadline
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, incident_number, title, description, priority, status, assignee_id,
                   NULL::TEXT AS assignee_name, reported_by, first_response_deadline,
                   resolution_deadline, first_responded_at, resolved_at, closed_at, version,
                   created_at, updated_at`,
        [
          input.title.trim(),
          input.description.trim(),
          input.priority,
          input.reportedBy.trim(),
          deadlines.firstResponseDeadline,
          deadlines.resolutionDeadline,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('PostgreSQL did not return the created incident');

      await client.query(
        `INSERT INTO timeline_events (incident_id, event_type, actor, metadata)
         VALUES ($1, 'incident_created', $2, jsonb_build_object('priority', $3::TEXT))`,
        [row.id, actor, row.priority],
      );
      await client.query(
        `INSERT INTO audit_log (incident_id, action, actor, new_data, request_id)
         VALUES ($1, 'incident.created', $2, $3::JSONB, $4)`,
        [row.id, actor, JSON.stringify(mapIncident(row)), requestId],
      );

      const outboxRows = [
        {
          type: 'first_response',
          deadline: deadlines.firstResponseDeadline,
        },
        { type: 'resolution', deadline: deadlines.resolutionDeadline },
      ] as const;
      for (const outbox of outboxRows) {
        await client.query(
          `INSERT INTO escalation_outbox
             (idempotency_key, incident_id, escalation_type, deadline)
           VALUES ($1, $2, $3, $4)`,
          [
            escalationIdempotencyKey(row.id, outbox.type, outbox.deadline),
            row.id,
            outbox.type,
            outbox.deadline,
          ],
        );
      }
      return mapIncident(row);
    });
  }

  async findById(id: string): Promise<Incident | null> {
    const result = await this.pool.query<IncidentRow>(`${incidentSelect} WHERE i.id = $1`, [id]);
    return result.rows[0] ? mapIncident(result.rows[0]) : null;
  }

  async requireById(id: string): Promise<Incident> {
    const incident = await this.findById(id);
    if (!incident) throw new NotFoundError('Incident');
    return incident;
  }

  async list(filters: IncidentFilters): Promise<{
    items: Incident[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (filters.status) conditions.push(`i.status = ${add(filters.status)}`);
    if (filters.priority) conditions.push(`i.priority = ${add(filters.priority)}`);
    if (filters.assigneeId) conditions.push(`i.assignee_id = ${add(filters.assigneeId)}`);
    if (filters.query) {
      conditions.push(
        `i.search_document @@ websearch_to_tsquery('english', ${add(filters.query)})`,
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = filters.query
      ? `ts_rank(i.search_document, websearch_to_tsquery('english', ${add(filters.query)})) DESC,
         i.created_at DESC`
      : 'i.created_at DESC';
    values.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const limitParameter = `$${values.length - 1}`;
    const offsetParameter = `$${values.length}`;
    const result = await this.pool.query<CountedIncidentRow>(
      `${incidentSelect.replace('SELECT ', 'SELECT COUNT(*) OVER() AS total_count, ')}
       ${where}
       ORDER BY ${order}
       LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
      values,
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      items: result.rows.map(mapIncident),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateIncidentInput,
    actor: string,
    requestId: string,
    slaTimeFactor: number,
  ): Promise<Incident> {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query<IncidentRow>(
        `${incidentSelect} WHERE i.id = $1 FOR UPDATE OF i`,
        [id],
      );
      const existing = locked.rows[0];
      if (!existing) throw new NotFoundError('Incident');
      if (existing.version !== expectedVersion) {
        throw new ConflictError('Incident was modified by another request', {
          expectedVersion,
          currentVersion: existing.version,
        });
      }
      if (input.status) assertTransition(existing.status, input.status);

      const assignments: string[] = [];
      const values: unknown[] = [];
      let updatedDeadlines: SlaDeadlines | undefined;
      const set = (column: string, value: unknown): void => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      };

      if (input.title !== undefined) set('title', input.title.trim());
      if (input.description !== undefined) set('description', input.description.trim());
      if (input.priority !== undefined && input.priority !== existing.priority) {
        set('priority', input.priority);
        updatedDeadlines = calculateSlaDeadlines(
          input.priority,
          existing.created_at,
          slaTimeFactor,
        );
        set('first_response_deadline', updatedDeadlines.firstResponseDeadline);
        set('resolution_deadline', updatedDeadlines.resolutionDeadline);
      }
      if (input.assigneeId !== undefined) set('assignee_id', input.assigneeId);
      if (input.status !== undefined) {
        set('status', input.status);
        if (input.status === 'Resolved') set('resolved_at', new Date());
        if (input.status === 'Closed') set('closed_at', new Date());
        if (existing.status === 'Resolved' && input.status === 'Monitoring')
          set('resolved_at', null);
      }
      const recordsFirstResponse =
        existing.first_responded_at === null &&
        ((input.assigneeId !== undefined && input.assigneeId !== null) ||
          (input.status !== undefined && input.status !== 'Open'));
      if (recordsFirstResponse) set('first_responded_at', new Date());

      if (assignments.length === 0) return mapIncident(existing);
      assignments.push('version = version + 1');
      values.push(id, expectedVersion);
      const updated = await client.query<IncidentRow>(
        `UPDATE incidents SET ${assignments.join(', ')}
          WHERE id = $${values.length - 1} AND version = $${values.length}
          RETURNING id, incident_number, title, description, priority, status, assignee_id,
                    (SELECT name FROM engineers WHERE id = assignee_id) AS assignee_name,
                    reported_by, first_response_deadline, resolution_deadline,
                    first_responded_at, resolved_at, closed_at, version, created_at, updated_at`,
        values,
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictError('Incident was modified by another request');

      const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
      if (input.status !== undefined && input.status !== existing.status) {
        events.push({
          type: 'status_changed',
          metadata: { from: existing.status, to: input.status },
        });
      }
      if (input.assigneeId !== undefined && input.assigneeId !== existing.assignee_id) {
        events.push({
          type: 'assignee_changed',
          metadata: { from: existing.assignee_id, to: input.assigneeId },
        });
      }
      if (input.priority !== undefined && input.priority !== existing.priority) {
        events.push({
          type: 'priority_changed',
          metadata: { from: existing.priority, to: input.priority },
        });
      }
      if (events.length === 0) events.push({ type: 'incident_updated', metadata: {} });
      for (const event of events) {
        await client.query(
          `INSERT INTO timeline_events (incident_id, event_type, actor, metadata)
           VALUES ($1, $2, $3, $4::JSONB)`,
          [id, event.type, actor, JSON.stringify(event.metadata)],
        );
      }
      if (updatedDeadlines) {
        for (const outbox of [
          { type: 'first_response' as const, deadline: updatedDeadlines.firstResponseDeadline },
          { type: 'resolution' as const, deadline: updatedDeadlines.resolutionDeadline },
        ]) {
          await client.query(
            `INSERT INTO escalation_outbox
               (idempotency_key, incident_id, escalation_type, deadline)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [
              escalationIdempotencyKey(id, outbox.type, outbox.deadline),
              id,
              outbox.type,
              outbox.deadline,
            ],
          );
        }
      }
      await client.query(
        `INSERT INTO audit_log (incident_id, action, actor, previous_data, new_data, request_id)
         VALUES ($1, 'incident.updated', $2, $3::JSONB, $4::JSONB, $5)`,
        [
          id,
          actor,
          JSON.stringify(mapIncident(existing)),
          JSON.stringify(mapIncident(row)),
          requestId,
        ],
      );
      return mapIncident(row);
    });
  }

  async addComment(
    incidentId: string,
    input: { author: string; body: string; type: 'comment' | 'mitigation' },
    requestId: string,
  ): Promise<{ id: string; createdAt: string }> {
    return withTransaction(this.pool, async (client) => {
      const exists = await client.query('SELECT 1 FROM incidents WHERE id = $1 FOR SHARE', [
        incidentId,
      ]);
      if (exists.rowCount === 0) throw new NotFoundError('Incident');
      const comment = await client.query<{ id: string; created_at: Date } & QueryResultRow>(
        `INSERT INTO incident_comments (incident_id, author, body, type)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [incidentId, input.author.trim(), input.body.trim(), input.type],
      );
      const row = comment.rows[0];
      if (!row) throw new Error('PostgreSQL did not return the created comment');
      await client.query(
        `INSERT INTO timeline_events (incident_id, event_type, actor, metadata)
         VALUES ($1, $2, $3, jsonb_build_object('commentId', $4::TEXT, 'body', $5::TEXT))`,
        [
          incidentId,
          input.type === 'mitigation' ? 'mitigation_added' : 'comment_added',
          input.author,
          row.id,
          input.body,
        ],
      );
      await client.query(
        `INSERT INTO audit_log (incident_id, action, actor, new_data, request_id)
         VALUES ($1, $2, $3, jsonb_build_object('commentId', $4::TEXT, 'type', $5::TEXT), $6)`,
        [incidentId, `incident.${input.type}_added`, input.author, row.id, input.type, requestId],
      );
      return { id: row.id, createdAt: row.created_at.toISOString() };
    });
  }

  async linkSimilar(
    incidentId: string,
    relatedIncidentId: string,
    actor: string,
    requestId: string,
  ): Promise<void> {
    if (incidentId === relatedIncidentId) {
      throw new ConflictError('An incident cannot be linked to itself');
    }
    const [lowerId, upperId] = [incidentId, relatedIncidentId].sort();
    if (!lowerId || !upperId) throw new Error('Unable to normalize incident link');
    await withTransaction(this.pool, async (client) => {
      const found = await client.query<{ id: string } & QueryResultRow>(
        'SELECT id FROM incidents WHERE id = ANY($1::UUID[])',
        [[lowerId, upperId]],
      );
      if (found.rowCount !== 2) throw new NotFoundError('One or more incidents');
      const inserted = await client.query(
        `INSERT INTO incident_links (incident_id, related_incident_id, created_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [lowerId, upperId, actor],
      );
      if (inserted.rowCount === 0) throw new ConflictError('Incidents are already linked');
      for (const id of [lowerId, upperId]) {
        const otherId = id === lowerId ? upperId : lowerId;
        await client.query(
          `INSERT INTO timeline_events (incident_id, event_type, actor, metadata)
           VALUES ($1, 'similar_incident_linked', $2, jsonb_build_object('relatedIncidentId', $3::TEXT))`,
          [id, actor, otherId],
        );
      }
      await client.query(
        `INSERT INTO audit_log (incident_id, action, actor, new_data, request_id)
         VALUES ($1, 'incident.linked', $2, jsonb_build_object('relatedIncidentId', $3::TEXT), $4)`,
        [incidentId, actor, relatedIncidentId, requestId],
      );
    });
  }

  async related(
    incidentId: string,
  ): Promise<Array<{ id: string; incidentNumber: string; title: string }>> {
    const result = await this.pool.query<
      { id: string; incident_number: string; title: string } & QueryResultRow
    >(
      `SELECT related.id, related.incident_number, related.title
         FROM incident_links link
         JOIN incidents related ON related.id = CASE
           WHEN link.incident_id = $1 THEN link.related_incident_id ELSE link.incident_id END
        WHERE link.incident_id = $1 OR link.related_incident_id = $1
        ORDER BY related.created_at DESC`,
      [incidentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      incidentNumber: row.incident_number,
      title: row.title,
    }));
  }

  async timeline(incidentId: string): Promise<unknown[]> {
    await this.requireById(incidentId);
    const result = await this.pool.query<TimelineRow>(
      `SELECT id, event_type, actor, metadata, occurred_at
         FROM timeline_events WHERE incident_id = $1 ORDER BY occurred_at, id`,
      [incidentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      actor: row.actor,
      metadata: row.metadata,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }

  async audit(incidentId: string): Promise<unknown[]> {
    await this.requireById(incidentId);
    const result = await this.pool.query<AuditRow>(
      `SELECT id::TEXT, action, actor, previous_data, new_data, request_id, created_at
         FROM audit_log WHERE incident_id = $1 ORDER BY created_at, id`,
      [incidentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor,
      previousData: row.previous_data,
      newData: row.new_data,
      requestId: row.request_id,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async engineers(): Promise<Array<{ id: string; name: string; email: string; active: boolean }>> {
    const result = await this.pool.query<EngineerRow>(
      'SELECT id, name, email, active FROM engineers ORDER BY name',
    );
    return result.rows;
  }

  async dashboard(): Promise<Record<string, unknown>> {
    const result = await this.pool.query<
      {
        total: string;
        active: string;
        breached: string;
        p1_active: string;
        resolved_last_24h: string;
        mean_resolution_seconds: string | null;
      } & QueryResultRow
    >(`
      SELECT
        COUNT(*)::TEXT AS total,
        COUNT(*) FILTER (WHERE status NOT IN ('Resolved', 'Closed'))::TEXT AS active,
        COUNT(*) FILTER (
          WHERE status NOT IN ('Resolved', 'Closed') AND resolution_deadline < clock_timestamp()
        )::TEXT AS breached,
        COUNT(*) FILTER (
          WHERE priority = 'P1' AND status NOT IN ('Resolved', 'Closed')
        )::TEXT AS p1_active,
        COUNT(*) FILTER (WHERE resolved_at >= clock_timestamp() - interval '24 hours')::TEXT
          AS resolved_last_24h,
        EXTRACT(EPOCH FROM AVG(resolved_at - created_at))::TEXT AS mean_resolution_seconds
      FROM incidents
    `);
    const row = result.rows[0];
    if (!row) throw new Error('PostgreSQL did not return dashboard metrics');
    const byStatus = await this.pool.query<{ status: string; count: string } & QueryResultRow>(
      'SELECT status::TEXT, COUNT(*)::TEXT AS count FROM incidents GROUP BY status ORDER BY status',
    );
    return {
      total: Number(row.total),
      active: Number(row.active),
      breached: Number(row.breached),
      p1Active: Number(row.p1_active),
      resolvedLast24Hours: Number(row.resolved_last_24h),
      meanResolutionSeconds: row.mean_resolution_seconds
        ? Math.round(Number(row.mean_resolution_seconds))
        : null,
      byStatus: Object.fromEntries(byStatus.rows.map((item) => [item.status, Number(item.count)])),
    };
  }
}
