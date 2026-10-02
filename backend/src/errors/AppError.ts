/**
 * Base application error.
 *
 * Domain errors extend this so the error handler can distinguish our
 * controlled failures (with stable codes and HTTP status) from unexpected
 * crashes (which always become 500 + generic message).
 */

export interface AppErrorOptions {
  code: string;
  httpStatus: number;
  message: string;
  /** Optional structured details surfaced to the client (never secrets). */
  details?: Record<string, unknown>;
  /** Original error, kept for logging but never sent to the client. */
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational = true;

  constructor(opts: AppErrorOptions) {
    super(opts.message);
    this.name = new.target.name;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    if (opts.cause !== undefined) this.cause = opts.cause;
    Error.captureStackTrace?.(this, new.target);
  }
}