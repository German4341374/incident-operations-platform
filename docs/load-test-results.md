# Load Smoke Results

## Measured baseline

This result was measured on 2026-08-02 by [GitHub Actions run 30752445082](https://github.com/German4341374/incident-operations-platform/actions/runs/30752445082) at commit `8915ba6`. The environment was an `ubuntu-24.04` shared runner with PostgreSQL 18.4 and Redis 8.8.1 service containers.

The four scenarios ran sequentially for three seconds each. Read scenarios used ten concurrent clients; incident creation used five. Each client issued a new request only after consuming the previous response, so there was no HTTP pipelining.

| Scenario | Requests/second | Total requests | p50 | p99 | Errors | Non-2xx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /health` | 4,586 | 13,776 | 2 ms | 13 ms | 0 | 0 |
| `GET /api/incidents?pageSize=20` | 1,215 | 3,652 | 7 ms | 23 ms | 0 | 0 |
| `GET /api/dashboard` | 2,352 | 7,066 | 4 ms | 15 ms | 0 | 0 |
| `POST /api/incidents` | 106 | 325 | 45 ms | 78 ms | 0 | 0 |

Result: **passed**. Every scenario met the committed criteria of zero transport errors, zero non-2xx responses, and p99 below 2,000 ms.

## Interpretation

The write path is intentionally slower because every request commits an incident, timeline event, audit record, and two outbox rows in one PostgreSQL transaction. This evidence is suitable for detecting large regressions and proving that the main endpoints tolerate light concurrency. It is not a production capacity claim: shared-runner hardware varies, the dataset is small, the run is short, and Redis/PostgreSQL are colocated with the application.

The complete machine-readable result is retained for 14 days as `quality-evidence/artifacts/load-smoke.json` on the linked workflow run. Future baselines should record their commit, runner, dataset, duration, concurrency, and pass criteria rather than comparing only requests per second.
