import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://app:password@localhost:5432/incidents',
  REDIS_URL: 'redis://localhost:6379',
};

describe('environment validation', () => {
  it('uses safe operational defaults', () => {
    const config = loadConfig(baseEnvironment);
    expect(config).toMatchObject({ PORT: 3000, QUEUE_CONCURRENCY: 5, SLA_TIME_FACTOR: 1 });
  });

  it('rejects a missing PostgreSQL URL', () => {
    expect(() => loadConfig({ REDIS_URL: baseEnvironment.REDIS_URL })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('rejects accelerated SLA time in production', () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, NODE_ENV: 'production', SLA_TIME_FACTOR: '0.001' }),
    ).toThrow('Production must use the real-time SLA factor');
  });

  it('allows accelerated SLA time for a development scenario', () => {
    expect(loadConfig({ ...baseEnvironment, SLA_TIME_FACTOR: '0.001' }).SLA_TIME_FACTOR).toBe(
      0.001,
    );
  });
});
