/** 统一错误模型：所有业务错误都抛 AppError，由全局 error handler 序列化。 */

export const ErrorCodes = {
  BAD_REQUEST: "BAD_REQUEST",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  BANNED: "BANNED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  TOKEN_INVALID_OR_EXPIRED: "TOKEN_INVALID_OR_EXPIRED",
  EMAIL_ALREADY_VERIFIED: "EMAIL_ALREADY_VERIFIED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message = "Bad request") =>
  new AppError(ErrorCodes.BAD_REQUEST, message, 400);
export const authRequired = (message = "Authentication required") =>
  new AppError(ErrorCodes.AUTH_REQUIRED, message, 401);
export const invalidCredentials = (message = "Invalid email or password") =>
  new AppError(ErrorCodes.INVALID_CREDENTIALS, message, 401);
export const forbidden = (message = "You don't have permission to do this") =>
  new AppError(ErrorCodes.FORBIDDEN, message, 403);
export const emailNotVerified = (message = "Please verify your email first") =>
  new AppError(ErrorCodes.EMAIL_NOT_VERIFIED, message, 403);
export const banned = (message = "Your account has been suspended") =>
  new AppError(ErrorCodes.BANNED, message, 403);
export const notFound = (message = "Not found") =>
  new AppError(ErrorCodes.NOT_FOUND, message, 404);
export const conflict = (message = "Conflict") =>
  new AppError(ErrorCodes.CONFLICT, message, 409);
export const rateLimited = (retryAfterMs: number, message = "Too many requests") =>
  new AppError(ErrorCodes.RATE_LIMITED, message, 429, { retryAfterMs });
export const tokenInvalid = (message = "Token is invalid or expired") =>
  new AppError(ErrorCodes.TOKEN_INVALID_OR_EXPIRED, message, 400);
export const internalError = (message = "Internal server error") =>
  new AppError(ErrorCodes.INTERNAL_ERROR, message, 500);
