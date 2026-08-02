import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString: string, maximumConnections = 10): pg.Pool {
  return new Pool({
    connectionString,
    max: maximumConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'incident-operations-platform',
  });
}
