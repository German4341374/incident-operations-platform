INSERT INTO engineers (id, name, email) VALUES
    ('10000000-0000-4000-8000-000000000001', 'Alex Morgan', 'alex.morgan@example.test'),
    ('10000000-0000-4000-8000-000000000002', 'Jordan Lee', 'jordan.lee@example.test'),
    ('10000000-0000-4000-8000-000000000003', 'Sam Rivera', 'sam.rivera@example.test')
ON CONFLICT (email) DO NOTHING;

WITH demo(title, description, priority, status, assignee_id, age_hours) AS (
    VALUES
        ('Authentication latency elevated', 'Users report slow sign-in responses across the customer portal.', 'P2'::incident_priority, 'Investigating'::incident_status, '10000000-0000-4000-8000-000000000001'::UUID, 2),
        ('Payment callback failures', 'Webhook callbacks are returning intermittent gateway errors.', 'P1'::incident_priority, 'Mitigating'::incident_status, '10000000-0000-4000-8000-000000000002'::UUID, 1),
        ('Analytics export delayed', 'Scheduled analytics exports are completing later than expected.', 'P3'::incident_priority, 'Monitoring'::incident_status, '10000000-0000-4000-8000-000000000003'::UUID, 8),
        ('Internal wiki unavailable', 'The documentation service cannot establish a database connection.', 'P2'::incident_priority, 'Resolved'::incident_status, '10000000-0000-4000-8000-000000000001'::UUID, 10),
        ('Printer queue warnings', 'Office print queue emits warnings but jobs continue successfully.', 'P4'::incident_priority, 'Open'::incident_status, NULL::UUID, 4)
)
INSERT INTO incidents (
    title, description, priority, status, assignee_id, reported_by,
    first_response_deadline, resolution_deadline, first_responded_at, resolved_at, created_at
)
SELECT
    title,
    description,
    priority,
    status,
    assignee_id,
    'Demo Operations',
    clock_timestamp() - make_interval(hours => age_hours) +
        CASE priority WHEN 'P1' THEN interval '15 minutes' WHEN 'P2' THEN interval '1 hour'
            WHEN 'P3' THEN interval '4 hours' ELSE interval '8 hours' END,
    clock_timestamp() - make_interval(hours => age_hours) +
        CASE priority WHEN 'P1' THEN interval '4 hours' WHEN 'P2' THEN interval '8 hours'
            WHEN 'P3' THEN interval '24 hours' ELSE interval '72 hours' END,
    CASE WHEN assignee_id IS NOT NULL THEN clock_timestamp() - make_interval(hours => age_hours) + interval '10 minutes' END,
    CASE WHEN status = 'Resolved' THEN clock_timestamp() - interval '1 hour' END,
    clock_timestamp() - make_interval(hours => age_hours)
FROM demo
ON CONFLICT DO NOTHING;

INSERT INTO timeline_events (incident_id, event_type, actor, metadata, occurred_at)
SELECT id, 'incident_created', 'Demo Operations', jsonb_build_object('priority', priority), created_at
FROM incidents
WHERE NOT EXISTS (
    SELECT 1 FROM timeline_events event WHERE event.incident_id = incidents.id
);
