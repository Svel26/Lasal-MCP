import type { z } from "zod";

export type ActionErrorCode =
  | "UNKNOWN_ACTION"
  | "INVALID_PARAMS"
  | "CONFIRM_REQUIRED"
  | "ACTION_NOT_AVAILABLE"
  | "PROJECT_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_PINNED"
  | "DRY_RUN_UNSUPPORTED"
  | "ASYNC_UNSUPPORTED"
  | "DESTRUCTIVE_DISABLED"
  | "PRECONDITION_FAILED"
  | "ENGINE_BUSY"
  | "ACTION_FAILED";

export interface ActionErrorDetails {
  fieldErrors?: Array<{ path: string; message: string; code: string }>;
  schema?: unknown;
  example?: unknown;
  suggestions?: string[];
  hints?: string[];
}

export class ActionExecutionError extends Error {
  readonly code: ActionErrorCode;
  readonly details: ActionErrorDetails;

  constructor(code: ActionErrorCode, message: string, details: ActionErrorDetails = {}) {
    super(message);
    this.name = "ActionExecutionError";
    this.code = code;
    this.details = details;
  }
}

export function zodFieldErrors(error: z.ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

export function isActionExecutionError(value: unknown): value is ActionExecutionError {
  return value instanceof ActionExecutionError;
}
