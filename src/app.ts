import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { ZodError, z } from 'zod';
import type { AppConfig } from './config.js';
import { incidentPriorities, incidentStatuses, InvalidTransitionError } from './domain/incident.js';
import { ApplicationError, ConflictError, PreconditionRequiredError } from './errors.js';
import { OutboxDispatcher } from './queue/escalation-queue.js';
import type { OutboxDispatcherPort } from './queue/escalation-queue.js';
import { EscalationRepository } from './repositories/escalation-repository.js';
import { IncidentRepository } from './repositories/incident-repository.js';
import { IncidentService } from './services/incident-service.js';

const createIncidentSchema = z.object({
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().min(10).max(10_000),
  priority: z.enum(incidentPriorities),
  reportedBy: z.string().trim().min(2).max(120),
});

const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(5).max(200).optional(),
    description: z.string().trim().min(10).max(10_000).optional(),
    priority: z.enum(incidentPriorities).optional(),
    status: z.enum(incidentStatuses).optional(),
    assigneeId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be supplied');

const commentSchema = z.object({
  author: z.string().trim().min(2).max(120),
  body: z.string().trim().min(1).max(5000),
  type: z.enum(['comment', 'mitigation']).default('comment'),
});

const linkSchema = z.object({
  relatedIncidentId: z.uuid(),
  actor: z.string().trim().min(2).max(120),
});

const idSchema = z.object({ id: z.uuid() });

function actorFrom(headers: Record<string, unknown>): string {
  const value = headers['x-actor'];
  if (typeof value !== 'string') return 'web-admin';
  const actor = value.trim();
  return actor.length >= 2 && actor.length <= 120 ? actor : 'web-admin';
}

function parseIfMatch(header: string | string[] | undefined): number {
  if (!header || Array.isArray(header)) throw new PreconditionRequiredError();
  const normalized = header.replaceAll('"', '').trim();
  const version = Number(normalized);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApplicationError(400, 'INVALID_VERSION', 'If-Match must contain a positive integer');
  }
  return version;
}

const incidentBodyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'priority', 'reportedBy'],
  properties: {
    title: { type: 'string', minLength: 5, maxLength: 200 },
    description: { type: 'string', minLength: 10, maxLength: 10000 },
    priority: { type: 'string', enum: incidentPriorities },
    reportedBy: { type: 'string', minLength: 2, maxLength: 120 },
  },
} as const;

export interface BuildAppOptions {
  config: AppConfig;
  pool: Pool;
  redis: Redis;
  dispatcher?: OutboxDispatcherPort;
  logger?: boolean;
  startDispatcher?: boolean;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    requestIdHeader: 'x-request-id',
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Incident Operations Platform API',
        description: 'Incident lifecycle, collaboration, SLA, timeline, and audit operations.',
        version: '1.0.0',
      },
      tags: [
        { name: 'Incidents', description: 'Incident lifecycle operations' },
        { name: 'Operations', description: 'Operational health and dashboard' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  await app.register(helmet, { contentSecurityPolicy: false });

  const repository = new IncidentRepository(options.pool);
  const escalationRepository = new EscalationRepository(options.pool);
  const managedDispatcher = options.dispatcher
    ? undefined
    : new OutboxDispatcher(options.redis, escalationRepository, options.config, app.log);
  const dispatcher = options.dispatcher ?? managedDispatcher;
  if (!dispatcher) throw new Error('Outbox dispatcher was not configured');
  const service = new IncidentService(repository, dispatcher, options.config.SLA_TIME_FACTOR);

  app.get('/health', {
    schema: {
      tags: ['Operations'],
      summary: 'Process liveness',
      response: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
    },
    handler: () => ({ status: 'ok' }),
  });

  app.get('/ready', {
    schema: { tags: ['Operations'], summary: 'PostgreSQL and Redis readiness' },
    handler: async (_request, reply) => {
      const dependencies = { postgres: 'up', redis: 'up' };
      await options.pool.query('SELECT 1').catch(() => {
        dependencies.postgres = 'down';
      });
      await options.redis.ping().catch(() => {
        dependencies.redis = 'down';
      });
      const ready = dependencies.postgres === 'up' && dependencies.redis === 'up';
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? 'ready' : 'not_ready', dependencies });
    },
  });

  app.get('/api/dashboard', {
    schema: { tags: ['Operations'], summary: 'Incident operations dashboard metrics' },
    handler: async () => repository.dashboard(),
  });

  app.get('/api/engineers', {
    schema: { tags: ['Incidents'], summary: 'List assignable engineers' },
    handler: async () => ({ items: await repository.engineers() }),
  });

  app.post('/api/incidents', {
    schema: {
      tags: ['Incidents'],
      summary: 'Register an incident and persist SLA outbox messages',
      body: incidentBodyJsonSchema,
    },
    handler: async (request, reply) => {
      const input = createIncidentSchema.parse(request.body);
      const incident = await service.create(input, actorFrom(request.headers), request.id);
      return reply.code(201).header('etag', `"${incident.version}"`).send(incident);
    },
  });

  app.get('/api/incidents', {
    schema: {
      tags: ['Incidents'],
      summary: 'Filter, search, and paginate incidents',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: incidentStatuses },
          priority: { type: 'string', enum: incidentPriorities },
          assigneeId: { type: 'string', format: 'uuid' },
          query: { type: 'string', minLength: 1, maxLength: 200 },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    handler: async (request) => {
      const query = z
        .object({
          status: z.enum(incidentStatuses).optional(),
          priority: z.enum(incidentPriorities).optional(),
          assigneeId: z.uuid().optional(),
          query: z.string().trim().min(1).max(200).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(request.query);
      return service.list(query);
    },
  });

  app.get('/api/incidents/:id', {
    schema: {
      tags: ['Incidents'],
      summary: 'Get incident detail and similar incident links',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    handler: async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const detail = await service.detail(id);
      return reply.header('etag', `"${detail.incident.version}"`).send(detail);
    },
  });

  app.patch('/api/incidents/:id', {
    schema: {
      tags: ['Incidents'],
      summary: 'Optimistically update lifecycle, priority, or assignee',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      headers: {
        type: 'object',
        required: ['if-match'],
        properties: {
          'if-match': { type: 'string', description: 'Current incident version, for example "3"' },
          'x-actor': { type: 'string' },
        },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: { type: 'string', minLength: 5, maxLength: 200 },
          description: { type: 'string', minLength: 10, maxLength: 10000 },
          priority: { type: 'string', enum: incidentPriorities },
          status: { type: 'string', enum: incidentStatuses },
          assigneeId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
        },
      },
    },
    handler: async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = updateIncidentSchema.parse(request.body);
      const version = parseIfMatch(request.headers['if-match']);
      const incident = await service.update(
        id,
        version,
        input,
        actorFrom(request.headers),
        request.id,
      );
      return reply.header('etag', `"${incident.version}"`).send(incident);
    },
  });

  app.post('/api/incidents/:id/comments', {
    schema: {
      tags: ['Incidents'],
      summary: 'Append a comment or mitigation note',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['author', 'body'],
        additionalProperties: false,
        properties: {
          author: { type: 'string', minLength: 2, maxLength: 120 },
          body: { type: 'string', minLength: 1, maxLength: 5000 },
          type: { type: 'string', enum: ['comment', 'mitigation'], default: 'comment' },
        },
      },
    },
    handler: async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const comment = commentSchema.parse(request.body);
      const created = await repository.addComment(id, comment, request.id);
      return reply.code(201).send(created);
    },
  });

  app.post('/api/incidents/:id/links', {
    schema: {
      tags: ['Incidents'],
      summary: 'Link a similar incident',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['relatedIncidentId', 'actor'],
        additionalProperties: false,
        properties: {
          relatedIncidentId: { type: 'string', format: 'uuid' },
          actor: { type: 'string', minLength: 2, maxLength: 120 },
        },
      },
    },
    handler: async (request, reply) => {
      const { id } = idSchema.parse(request.params);
      const input = linkSchema.parse(request.body);
      await repository.linkSimilar(id, input.relatedIncidentId, input.actor, request.id);
      return reply.code(201).send({ linked: true });
    },
  });

  app.get('/api/incidents/:id/timeline', {
    schema: {
      tags: ['Incidents'],
      summary: 'Get the chronological operational timeline',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    handler: async (request) => {
      const { id } = idSchema.parse(request.params);
      return { items: await repository.timeline(id) };
    },
  });

  app.get('/api/incidents/:id/audit', {
    schema: {
      tags: ['Incidents'],
      summary: 'Get immutable before/after audit records',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
    handler: async (request) => {
      const { id } = idSchema.parse(request.params);
      return { items: await repository.audit(id) };
    },
  });

  const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
  await app.register(fastifyStatic, { root: publicDirectory, prefix: '/' });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InvalidTransitionError) {
      const conflict = new ConflictError(error.message, { from: error.from, to: error.to });
      return reply.code(conflict.statusCode).send({
        error: {
          code: conflict.code,
          message: conflict.message,
          details: conflict.details,
          requestId: request.id,
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues,
          requestId: request.id,
        },
      });
    }
    if (error instanceof ApplicationError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      const validationError = error as { message?: unknown; validation: unknown };
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message:
            typeof validationError.message === 'string'
              ? validationError.message
              : 'Request validation failed',
          details: validationError.validation,
          requestId: request.id,
        },
      });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Route was not found', requestId: request.id },
    }),
  );

  if (managedDispatcher && options.startDispatcher !== false) managedDispatcher.start();
  if (managedDispatcher) {
    app.addHook('onClose', async () => managedDispatcher.close());
  }
  return app;
}
