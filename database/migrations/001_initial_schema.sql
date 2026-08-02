CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE incident_priority AS ENUM ('P1', 'P2', 'P3', 'P4');
CREATE TYPE incident_status AS ENUM (
    'Open',
    'Investigating',
    'Mitigating',
    'Monitoring',
    'Resolved',
    'Closed'
);
CREATE TYPE comment_type AS ENUM ('comment', 'mitigation');
CREATE TYPE escalation_type AS ENUM ('first_response', 'resolution');

CREATE SEQUENCE incident_number_sequence START 1001;

CREATE TABLE engineers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_number TEXT NOT NULL UNIQUE DEFAULT
        ('INC-' || lpad(nextval('incident_number_sequence')::TEXT, 6, '0')),
    title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 5 AND 200),
    description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 10 AND 10000),
    priority incident_priority NOT NULL,
    status incident_status NOT NULL DEFAULT 'Open',
    assignee_id UUID REFERENCES engineers(id) ON DELETE SET NULL,
    reported_by TEXT NOT NULL CHECK (length(btrim(reported_by)) BETWEEN 2 AND 120),
    first_response_deadline TIMESTAMPTZ NOT NULL,
    resolution_deadline TIMESTAMPTZ NOT NULL,
    first_responded_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    search_document TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED,
    CHECK (resolution_deadline >= first_response_deadline),
    CHECK (resolved_at IS NULL OR resolved_at >= created_at),
    CHECK (closed_at IS NULL OR resolved_at IS NOT NULL)
);

CREATE TABLE incident_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK (length(btrim(author)) BETWEEN 2 AND 120),
    body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
    type comment_type NOT NULL DEFAULT 'comment',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE incident_links (
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    related_incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL DEFAULT 'similar' CHECK (relationship = 'similar'),
    created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 2 AND 120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (incident_id, related_incident_id),
    CHECK (incident_id < related_incident_id)
);

CREATE TABLE timeline_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 2 AND 80),
    actor TEXT NOT NULL CHECK (length(btrim(actor)) BETWEEN 2 AND 120),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (length(action) BETWEEN 2 AND 80),
    actor TEXT NOT NULL CHECK (length(btrim(actor)) BETWEEN 2 AND 120),
    previous_data JSONB,
    new_data JSONB,
    request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE escalation_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    escalation_type escalation_type NOT NULL,
    deadline TIMESTAMPTZ NOT NULL,
    dispatched_at TIMESTAMPTZ,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE escalation_executions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    escalation_type escalation_type NOT NULL,
    deadline TIMESTAMPTZ NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'skipped')),
    detail TEXT NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX incidents_status_idx ON incidents(status);
CREATE INDEX incidents_priority_idx ON incidents(priority);
CREATE INDEX incidents_assignee_idx ON incidents(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX incidents_resolution_deadline_idx
    ON incidents(resolution_deadline)
    WHERE status NOT IN ('Resolved', 'Closed');
CREATE INDEX incidents_search_idx ON incidents USING GIN(search_document);
CREATE INDEX comments_incident_created_idx ON incident_comments(incident_id, created_at);
CREATE INDEX timeline_incident_occurred_idx ON timeline_events(incident_id, occurred_at);
CREATE INDEX audit_incident_created_idx ON audit_log(incident_id, created_at);
CREATE INDEX escalation_outbox_pending_idx
    ON escalation_outbox(created_at)
    WHERE dispatched_at IS NULL;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER incidents_set_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
