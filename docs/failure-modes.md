# Failure Modes and Runbook

## Redis unavailable

**Detection:** `/ready` returns `503` with `redis: down`; API logs contain `redis_error` or `outbox message dispatch failed`; undispatched outbox rows increase.

**Impact:** incident writes, comments, and state changes remain durable in PostgreSQL. New escalation jobs are not transported until Redis returns. Existing delayed jobs are unavailable while Redis is down.

**Recovery:** restore Redis, confirm `redis-cli ping`, and wait for the API outbox poll. Verify backlog:

```sql
SELECT count(*) AS pending, min(created_at) AS oldest
FROM escalation_outbox
WHERE dispatched_at IS NULL;
```

The dispatcher reuses stable BullMQ job IDs, so repeating dispatch is safe. Restart `api` only if the Redis client does not reconnect after Redis is healthy.

## PostgreSQL unavailable

**Detection:** `/ready` returns `503` with `postgres: down`; API data requests return a safe server error; worker jobs fail and BullMQ records attempts.

**Impact:** no incident mutation or escalation result can commit. Redis may still hold delayed jobs. The worker transaction rolls back, so an execution is not partially recorded.

**Recovery:** restore PostgreSQL, check `pg_isready`, verify storage space and connection limits, then restart unhealthy containers. BullMQ retries temporary failures according to its attempt policy. If downtime exceeds all attempts, review failed jobs and replay them only after confirming PostgreSQL health.

## Worker crash during escalation

If PostgreSQL has not committed, the claim, timeline, and audit writes all roll back and BullMQ retries. If PostgreSQL committed but the worker failed before acknowledging Redis, the retry finds the unique execution key and returns `duplicate`. No second escalation event is written.

## API crash after incident commit

The incident and outbox intent already exist in one transaction. A restarted API polls the undispatched record and schedules it. This is the main reason Redis is not written inside the incident transaction.

## Poison or repeatedly failing jobs

Queue jobs use five attempts and exponential backoff beginning at two seconds. Failed jobs are retained for seven days. Do not blindly retry every failed job. Inspect its error and incident state, correct the dependency or data issue, and replay one job while watching the timeline and `escalation_executions`.

## Outbox says dispatched but Redis lost the job

Redis append-only persistence reduces but does not eliminate this single-node failure mode. Compare unresolved incidents with executions after a major Redis restore:

```sql
SELECT i.incident_number, o.escalation_type, o.deadline, o.idempotency_key
FROM escalation_outbox o
JOIN incidents i ON i.id = o.incident_id
LEFT JOIN escalation_executions x ON x.idempotency_key = o.idempotency_key
WHERE o.dispatched_at IS NOT NULL
  AND x.id IS NULL
  AND o.deadline < clock_timestamp()
  AND i.status NOT IN ('Resolved', 'Closed');
```

For each confirmed missing job, set that outbox row's `dispatched_at` to `NULL`. The stable idempotency key makes redispatch safe.

## Optimistic-lock conflict storm

HTTP `409` indicates clients are updating stale versions. Clients should fetch the latest incident and let an operator reconcile intent; they must not automatically overwrite with a new version. High conflict rates often indicate UI tabs left open or an automation using cached data.

## Graceful shutdown

The API stops accepting requests, closes its outbox queue, then closes Redis and PostgreSQL connections. The worker stops taking new work and waits for active jobs. Docker gives services time to exit before forcing termination. Inspect structured shutdown logs before treating a stopped container as a crash.
