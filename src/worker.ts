import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { escalationQueueName } from './queue/escalation-queue.js';
import type { EscalationJobData } from './repositories/escalation-repository.js';
import { EscalationRepository } from './repositories/escalation-repository.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, config.QUEUE_CONCURRENCY + 2);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
const repository = new EscalationRepository(pool);

await runMigrations(pool);

const worker = new Worker<EscalationJobData>(
  escalationQueueName,
  async (job) => {
    const outcome = await repository.execute(job.data);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'escalation_processed',
        jobId: job.id,
        incidentId: job.data.incidentId,
        escalationType: job.data.escalationType,
        outcome,
      }),
    );
    return { outcome };
  },
  { connection: redis, concurrency: config.QUEUE_CONCURRENCY },
);

worker.on('failed', (job, error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'escalation_failed',
      jobId: job?.id,
      attempt: job?.attemptsMade,
      error: error.message,
    }),
  );
});
worker.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', event: 'worker_error', error: error.message }));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'worker_shutdown', signal }));
  const forceExit = setTimeout(() => process.exit(1), 30_000);
  forceExit.unref();
  await worker.close();
  await redis.quit().catch(() => redis.disconnect());
  await pool.end();
  clearTimeout(forceExit);
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
