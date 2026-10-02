import { AppError } from './AppError';

export { AppError } from './AppError';

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: Record<string, unknown>) {
    super({ code: 'VALIDATION_ERROR', httpStatus: 400, message, details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', code = 'AUTH_REQUIRED') {
    super({ code, httpStatus: 401, message });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Not permitted', code = 'AUTH_FORBIDDEN') {
    super({ code, httpStatus: 403, message });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', code = 'NOT_FOUND') {
    super({ code, httpStatus: 404, message: `${resource} not found` });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super({ code, httpStatus: 409, message });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super({ code: 'RATE_LIMIT_EXCEEDED', httpStatus: 429, message });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super({ code: 'INTERNAL_ERROR', httpStatus: 500, message, cause });
  }
}