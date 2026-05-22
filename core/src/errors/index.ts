// Domain-level errors. Adapter layer maps these to HTTP status codes — see
// daemon/middleware/errorHandler.ts.

export class DomainError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
  }
}

export class ConflictError extends DomainError {}
export class ValidationError extends DomainError {}
export class PermissionDeniedError extends DomainError {}
export class LimitExceededError extends DomainError {}
export class UnreachableError extends DomainError {
  constructor(service: string, cause?: unknown) {
    super(`unreachable: ${service}`, cause);
  }
}
