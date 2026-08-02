import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { EscalationRepository } from '../../src/repositories/escalation-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const integration = describe.skipIf(!databaseUrl || !redisUrl);

integration('incident API with PostgreSQL and Redis', () => {
  let pool: Pool;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const dispatcher = { flushOnce: () => Promise.resolve(0) };
  const config: AppConfig = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3000,
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrl ?? '',
    REDIS_URL: redisUrl ?? '',
    QUEUE_CONCURRENCY: 2,
    OUTBOX_POLL_INTERVAL_MS: 5000,
    ESCALATION_ATTEMPTS: 3,
    ESCALATION_BACKOFF_MS: 100,
    SLA_TIME_FACTOR: 1,
  };
  const engineerId = '20000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    pool = createPool(config.DATABASE_URL, 5);
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    await runMigrations(pool);
    app = await buildApp({
      config,
      pool,
      redis,
      dispatcher,
      logger: true,
      startDispatcher: false,
    });
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE escalation_executions, escalation_outbox, audit_log, timeline_events,
               incident_links, incident_comments, incidents, engineers RESTART IDENTITY CASCADE
    `);
    await pool.query(
      `INSERT INTO engineers (id, name, email) VALUES ($1, 'Test Engineer', 'engineer@example.test')`,
      [engineerId],
    );
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await pool.end();
  });

  async function createIncident(title = 'Customer portal cannot authenticate') {
    return app.inject({
      method: 'POST',
      url: '/api/incidents',
      headers: { 'x-actor': 'Integration Test' },
      payload: {
        title,
        description: `Detailed synthetic support report for ${title.toLowerCase()}.`,
        priority: 'P1',
        reportedBy: 'Support Desk',
      },
    });
  }

  it('reports dependency readiness', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready' });
  });

  it('creates an incident and two durable SLA outbox messages', async () => {
    const response = await createIncident();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ priority: 'P1', status: 'Open', version: 1 });
    const outbox = await pool.query(
      'SELECT escalation_type FROM escalation_outbox ORDER BY escalation_type',
    );
    expect(outbox.rows).toHaveLength(2);
  });

  it('performs PostgreSQL full-text search with pagination', async () => {
    await createIncident('Customer portal authentication failure');
    await createIncident('Printer toner warning');
    const response = await app.inject({
      method: 'GET',
      url: '/api/incidents?query=authentication&page=1&pageSize=10',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pagination.total).toBe(1);
    expect(response.json().items[0].title).toContain('authentication');
  });

  it('rejects a stale optimistic lock version', async () => {
    const created = await createIncident();
    const incident = created.json();
    const first = await app.inject({
      method: 'PATCH',
      url: `/api/incidents/${incident.id}`,
      headers: { 'if-match': '"1"', 'x-actor': 'Engineer A' },
      payload: { assigneeId: engineerId, status: 'Investigating' },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/incidents/${incident.id}`,
      headers: { 'if-match': '"1"', 'x-actor': 'Engineer B' },
      payload: { status: 'Resolved' },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.details).toMatchObject({ expectedVersion: 1, currentVersion: 2 });
  });

  it('enforces the incident state machine', async () => {
    const incident = (await createIncident()).json();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/incidents/${incident.id}`,
      headers: { 'if-match': '1' },
      payload: { status: 'Closed' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.message).toContain('Open to Closed');
  });

  it('records comments, mitigation, timeline, and audit data', async () => {
    const incident = (await createIncident()).json();
    const comment = await app.inject({
      method: 'POST',
      url: `/api/incidents/${incident.id}/comments`,
      payload: {
        author: 'Test Engineer',
        body: 'Traffic shifted to healthy nodes.',
        type: 'mitigation',
      },
    });
    expect(comment.statusCode).toBe(201);
    const timeline = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incident.id}/timeline`,
    });
    expect(timeline.json().items.map((item: { eventType: string }) => item.eventType)).toContain(
      'mitigation_added',
    );
    const audit = await app.inject({ method: 'GET', url: `/api/incidents/${incident.id}/audit` });
    expect(audit.json().items).toHaveLength(2);
  });

  it('links two similar incidents exactly once', async () => {
    const first = (await createIncident('Authentication failure in Europe')).json();
    const second = (await createIncident('Authentication failure in America')).json();
    const linked = await app.inject({
      method: 'POST',
      url: `/api/incidents/${first.id}/links`,
      payload: { relatedIncidentId: second.id, actor: 'Test Engineer' },
    });
    expect(linked.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/incidents/${first.id}/links`,
      payload: { relatedIncidentId: second.id, actor: 'Test Engineer' },
    });
    expect(duplicate.statusCode).toBe(409);
    const detail = await app.inject({ method: 'GET', url: `/api/incidents/${first.id}` });
    expect(detail.json().related).toHaveLength(1);
  });

  it('executes an escalation only once for a repeated logical job', async () => {
    const incident = (await createIncident()).json();
    const deadline = await pool.query<{ resolution_deadline: Date }>(
      'SELECT resolution_deadline FROM incidents WHERE id = $1',
      [incident.id],
    );
    await pool.query(
      `UPDATE incidents
          SET first_response_deadline = clock_timestamp() - interval '2 minutes',
              resolution_deadline = clock_timestamp() - interval '1 minute'
        WHERE id = $1`,
      [incident.id],
    );
    const pastDeadline = await pool.query<{ resolution_deadline: Date }>(
      'SELECT resolution_deadline FROM incidents WHERE id = $1',
      [incident.id],
    );
    expect(deadline.rows[0]).toBeDefined();
    const job = {
      idempotencyKey: `test--${incident.id}`,
      incidentId: incident.id,
      escalationType: 'resolution' as const,
      deadline: pastDeadline.rows[0]?.resolution_deadline.toISOString() ?? '',
    };
    const repository = new EscalationRepository(pool);
    expect(await repository.execute(job)).toBe('completed');
    expect(await repository.execute(job)).toBe('duplicate');
    const timeline = await pool.query(
      "SELECT 1 FROM timeline_events WHERE incident_id = $1 AND event_type = 'sla_escalated'",
      [incident.id],
    );
    expect(timeline.rowCount).toBe(1);
  });
});
