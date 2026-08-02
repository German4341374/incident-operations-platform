export class ApplicationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export class NotFoundError extends ApplicationError {
  constructor(resource: string) {
    super(404, 'NOT_FOUND', `${resource} was not found`);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(409, 'CONFLICT', message, details);
  }
}

export class PreconditionRequiredError extends ApplicationError {
  constructor() {
    super(428, 'VERSION_REQUIRED', 'The If-Match header is required for this update');
  }
}
