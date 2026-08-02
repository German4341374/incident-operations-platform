import type { Pool, QueryResultRow } from 'pg';
import type { EscalationType } from '../domain/incident.js';

export interface OutboxMessage {
  id: string;
  idempotencyKey: string;
  incidentId: string;
  escalationType: EscalationType;
  deadline: Date;
}

export interface EscalationJobData {
  idempotencyKey: string;
  incidentId: string;
  escalationType: EscalationType;
  deadline: string;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  incident_id: string;
  escalation_type: EscalationType;
  deadline: Date;
}

interface EscalationIncidentRow extends QueryResultRow {
  status: string;
  first_response_deadline: Date;
  resolution_deadline: Date;
  first_responded_at: Date | null;
}

export class EscalationRepository {
  constructor(private readonly pool: Pool) {}

  async pendingOutbox(limit = 100): Promise<OutboxMessage[]> {
    const result = await this.pool.query<OutboxRow>(
      `SELECT id::TEXT, idempotency_key, incident_id, escalation_type, deadline
         FROM escalation_outbox
        WHERE dispatched_at IS NULL
        ORDER BY id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      incidentId: row.incident_id,
      escalationType: row.escalation_type,
      deadline: row.deadline,
    }));
  }

  async markDispatched(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE escalation_outbox
          SET dispatched_at = clock_timestamp(), dispatch_attempts = dispatch_attempts + 1,
              last_error = NULL
        WHERE id = $1 AND dispatched_at IS NULL`,
      [id],
    );
  }

  async markDispatchFailure(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE escalation_outbox
          SET dispatch_attempts = dispatch_attempts + 1, last_error = left($2, 1000)
        WHERE id = $1 AND dispatched_at IS NULL`,
      [id, error],
    );
  }

  async execute(job: EscalationJobData): Promise<'completed' | 'skipped' | 'duplicate'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO escalation_executions
           (idempotency_key, incident_id, escalation_type, deadline, outcome, detail)
         VALUES ($1, $2, $3, $4, 'skipped', 'processing')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id::TEXT`,
        [job.idempotencyKey, job.incidentId, job.escalationType, job.deadline],
      );
      const execution = claimed.rows[0];
      if (!execution) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }

      const incidentResult = await client.query<EscalationIncidentRow>(
        `SELECT status::TEXT, first_response_deadline, resolution_deadline, first_responded_at
           FROM incidents WHERE id = $1 FOR UPDATE`,
        [job.incidentId],
      );
      const incident = incidentResult.rows[0];
      if (!incident) {
        await client.query(
          `UPDATE escalation_executions SET detail = 'incident_deleted' WHERE id = $1`,
          [execution.id],
        );
        await client.query('COMMIT');
        return 'skipped';
      }

      const expectedDeadline =
        job.escalationType === 'first_response'
          ? incident.first_response_deadline
          : incident.resolution_deadline;
      const isSuperseded = expectedDeadline.getTime() !== new Date(job.deadline).getTime();
      const terminal = incident.status === 'Resolved' || incident.status === 'Closed';
      const conditionMet =
        job.escalationType === 'first_response' ? incident.first_responded_at !== null : terminal;
      if (isSuperseded || conditionMet) {
        const detail = isSuperseded ? 'superseded_deadline' : 'sla_condition_met';
        await client.query(`UPDATE escalation_executions SET detail = $2 WHERE id = $1`, [
          execution.id,
          detail,
        ]);
        await client.query('COMMIT');
        return 'skipped';
      }

      await client.query(
        `INSERT INTO timeline_events (incident_id, event_type, actor, metadata)
         VALUES ($1, 'sla_escalated', 'SLA automation',
                 jsonb_build_object('type', $2::TEXT, 'deadline', $3::TEXT,
                                    'idempotencyKey', $4::TEXT))`,
        [job.incidentId, job.escalationType, job.deadline, job.idempotencyKey],
      );
      await client.query(
        `INSERT INTO audit_log (incident_id, action, actor, new_data, request_id)
         VALUES ($1, 'incident.sla_escalated', 'SLA automation',
                 jsonb_build_object('type', $2::TEXT, 'deadline', $3::TEXT), $4)`,
        [job.incidentId, job.escalationType, job.deadline, job.idempotencyKey],
      );
      await client.query(
        `UPDATE escalation_executions
            SET outcome = 'completed', detail = 'sla_breached'
          WHERE id = $1`,
        [execution.id],
      );
      await client.query('COMMIT');
      return 'completed';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
