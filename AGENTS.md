# Repository Guidance

- Keep all code, comments, configuration, and documentation in English.
- Preserve the incident state machine and optimistic-lock contract.
- Never enqueue an escalation without first recording its outbox entry in PostgreSQL.
- Keep SQL parameterized and migrations forward-only.
- Do not commit secrets, real incident data, or generated load artifacts.
- Run `npm run check` and `npm run build` before proposing changes.
