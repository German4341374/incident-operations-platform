# Incident Lifecycle

| Current       | Allowed next states              | Rationale                                                                  |
| ------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Open          | Investigating, Resolved          | Triage starts, or a duplicate/false alarm is resolved directly.            |
| Investigating | Mitigating, Monitoring, Resolved | The team can apply a mitigation, observe a suspected recovery, or resolve. |
| Mitigating    | Monitoring, Resolved             | A mitigation is observed before closure or resolves the incident.          |
| Monitoring    | Mitigating, Resolved             | Regression returns to mitigation; sustained health permits resolution.     |
| Resolved      | Monitoring, Closed               | A recurrence reopens into observation; confirmation closes the record.     |
| Closed        | None                             | Closed is terminal to preserve the historical record.                      |

An identical status update is accepted as an idempotent no-op. The API rejects illegal transitions with HTTP `409` before changing the row.

`Resolved` records `resolvedAt`. `Resolved → Monitoring` clears it because resolution is no longer valid. `Resolved → Closed` records `closedAt`. PostgreSQL requires a resolved timestamp before a closed timestamp can exist.

Assignment or the first move beyond `Open` records `firstRespondedAt`. The first-response escalation job checks this timestamp rather than inferring acknowledgement from the current status.
