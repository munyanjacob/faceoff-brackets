/**
 * The single error type every service function throws on a non-2xx response.
 * `code` is the stable machine-readable slug; `message` is user-facing copy.
 */
export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
  }
}

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError("UNEXPECTED", GENERIC_ERROR_MESSAGE, 500);
}
