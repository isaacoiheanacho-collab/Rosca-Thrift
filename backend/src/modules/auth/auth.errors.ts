/**
 * Auth-specific error codes and helpers.
 * Extend the shared AppError hierarchy so the error handler treats them uniformly.
 */

import { AppError, AuthenticationError, ConflictError } from '../../errors';

export const AuthErrorCode = {
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',
  PHONE_TAKEN: 'AUTH_PHONE_TAKEN',
  TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  TOKEN_REVOKED: 'AUTH_TOKEN_REVOKED',
  TOKEN_REUSED: 'AUTH_TOKEN_REUSED',
  ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export class InvalidCredentialsError extends AuthenticationError {
  constructor() {
    super('Invalid email/phone or password', AuthErrorCode.INVALID_CREDENTIALS);
  }
}

export class EmailTakenError extends ConflictError {
  constructor() {
    super('Email is already registered', AuthErrorCode.EMAIL_TAKEN);
  }
}

export class PhoneTakenError extends ConflictError {
  constructor() {
    super('Phone is already registered', AuthErrorCode.PHONE_TAKEN);
  }
}

export class TokenInvalidError extends AuthenticationError {
  constructor(message = 'Token is invalid') {
    super(message, AuthErrorCode.TOKEN_INVALID);
  }
}

export class TokenExpiredError extends AuthenticationError {
  constructor() {
    super('Token has expired', AuthErrorCode.TOKEN_EXPIRED);
  }
}

export class TokenRevokedError extends AuthenticationError {
  constructor() {
    super('Token has been revoked', AuthErrorCode.TOKEN_REVOKED);
  }
}

/**
 * Special case: a refresh token was already used. This is a strong signal
 * of theft — we revoke ALL of the user's tokens and force re-login.
 */
export class TokenReusedError extends AuthenticationError {
  constructor() {
    super('Refresh token already used — all sessions revoked', AuthErrorCode.TOKEN_REUSED);
  }
}

export class AccountSuspendedError extends AppError {
  constructor() {
    super({
      code: AuthErrorCode.ACCOUNT_SUSPENDED,
      httpStatus: 403,
      message: 'Account is suspended',
    });
  }
}