# Demonstration Scenario

This scenario exercises the real API, PostgreSQL outbox, Redis delayed job, BullMQ worker, state machine, timeline, and audit log.

## Start an accelerated development stack

PowerShell:

```powershell
$env:SLA_TIME_FACTOR = "0.005"
docker compose up --build --wait
npm ci
npm run demo:scenario
```

Bash/WSL2:

```bash
SLA_TIME_FACTOR=0.005 docker compose up --build --wait
npm ci
npm run demo:scenario
```

The factor changes elapsed demonstration time, not the documented SLA policy. P1 first response becomes approximately 4.5 seconds and P1 resolution approximately 72 seconds. Assignment should satisfy the first-response job; the unresolved resolution job produces the automatic escalation. Production configuration rejects any factor other than `1`.

## Expected sequence

1. A synthetic P1 incident is registered.
2. The first seeded engineer is assigned and status changes to `Investigating`.
3. The script waits for `sla_escalated` from the worker.
4. A mitigation note is appended and status changes to `Mitigating`.
5. Status changes to `Monitoring`.
6. The incident moves to `Resolved` and then `Closed`.
7. The script fetches timeline and audit records and prints their counts.

Inspect the same incident in the browser or use the final UUID printed by the script:

```bash
curl http://localhost:3000/api/incidents/INCIDENT_UUID/timeline
curl http://localhost:3000/api/incidents/INCIDENT_UUID/audit
```

If no escalation appears, inspect `docker compose logs worker api redis` and follow the Redis recovery steps in [Failure modes and runbook](failure-modes.md).
