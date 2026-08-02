import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    REDIS_URL: z.string().url().startsWith('redis://'),
    QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(5000),
    ESCALATION_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    ESCALATION_BACKOFF_MS: z.coerce.number().int().min(100).max(60000).default(2000),
    SLA_TIME_FACTOR: z.coerce.number().min(0.001).max(1).default(1),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.SLA_TIME_FACTOR !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['SLA_TIME_FACTOR'],
        message: 'Production must use the real-time SLA factor of 1',
      });
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
