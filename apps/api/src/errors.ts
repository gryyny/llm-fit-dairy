import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Response } from "express";

type ErrorCode =
  | "invalid_credential"
  | "profile_not_available"
  | "forbidden"
  | "not_found"
  | "version_conflict"
  | "request_id_reused"
  | "consent_required"
  | "food_identity_conflict"
  | "invalid_input"
  | "rate_limited"
  | "internal_error";

/** CH-3 error: rendered as JSON `{code, message, current?}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly current?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const invalidInput = (message: string) => new ApiError(400, "invalid_input", message);

const codeForStatus: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: "invalid_input",
  [HttpStatus.UNAUTHORIZED]: "invalid_credential",
  [HttpStatus.NOT_FOUND]: "not_found",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "invalid_input",
};

function httpMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === "object" && "message" in body) {
    const message: unknown = body.message;
    if (Array.isArray(message)) return message.map(String).join("; ");
    if (typeof message === "string") return message;
  }
  return exception.message;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ApiError) {
      res.status(exception.status).json({
        code: exception.code,
        message: exception.message,
        ...(exception.current === undefined ? {} : { current: exception.current }),
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = codeForStatus[status];
      if (code) {
        // Keep CH-3's 400 contract when Nest wraps an oversized-body error.
        const responseStatus = status === 413 ? 400 : status;
        res.status(responseStatus).json({ code, message: httpMessage(exception) });
        return;
      }
    }
    // Body-parser errors carry an HTTP status but are not Nest exceptions.
    if (exception instanceof Error && "status" in exception) {
      if (exception.status === 400) {
        res.status(400).json({ code: "invalid_input", message: "Request body is not valid JSON" });
        return;
      }
      if (exception.status === 413) {
        res
          .status(400)
          .json({ code: "invalid_input", message: "Request body is larger than 1 MB" });
        return;
      }
    }
    console.error(
      JSON.stringify({
        level: "error",
        message: "unhandled error",
        error: exception instanceof Error ? exception.name : typeof exception,
      }),
    );
    res.status(500).json({ code: "internal_error", message: "Internal server error" });
  }
}
