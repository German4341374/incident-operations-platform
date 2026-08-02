import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type {
  EscalationJobData,
  EscalationRepository,
} from '../repositories/escalation-repository.js';

export const escalationQueueName = 'incident-sla-escalations';

export interface OutboxDispatcherPort {
  flushOnce(): Promise<number>;
}

export class OutboxDispatcher implements OutboxDispatcherPort {
  private readonly queue: Queue<EscalationJobData>;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    redis: Redis,
    private readonly repository: EscalationRepository,
    private readonly config: AppConfig,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.queue = new Queue<EscalationJobData>(escalationQueueName, { connection: redis });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushOnce().catch((error: unknown) => {
        this.logger.error({ err: error }, 'outbox dispatch cycle failed');
      });
    }, this.config.OUTBOX_POLL_INTERVAL_MS);
    this.timer.unref();
    void this.flushOnce().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'initial outbox dispatch delayed');
    });
  }

  async flushOnce(): Promise<number> {
    const messages = await this.repository.pendingOutbox();
    let dispatched = 0;
    for (const message of messages) {
      try {
        const job: EscalationJobData = {
          idempotencyKey: message.idempotencyKey,
          incidentId: message.incidentId,
          escalationType: message.escalationType,
          deadline: message.deadline.toISOString(),
        };
        await this.queue.add(message.escalationType, job, {
          jobId: message.idempotencyKey,
          delay: Math.max(0, message.deadline.getTime() - Date.now()),
          attempts: this.config.ESCALATION_ATTEMPTS,
          backoff: { type: 'exponential', delay: this.config.ESCALATION_BACKOFF_MS },
          removeOnComplete: { age: 86_400, count: 2000 },
          removeOnFail: { age: 604_800, count: 5000 },
        });
        await this.repository.markDispatched(message.id);
        dispatched += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.repository.markDispatchFailure(message.id, detail).catch(() => undefined);
        this.logger.warn({ err: error, outboxId: message.id }, 'outbox message dispatch failed');
        break;
      }
    }
    return dispatched;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue.close();
  }
}
