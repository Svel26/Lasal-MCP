export const ERROR_CODES = {
  PLC_UNREACHABLE: "PLC_UNREACHABLE",
  PROJECT_LOCKED: "PROJECT_LOCKED",
  COMPILE_FAILED: "COMPILE_FAILED",
  CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TRANSIENT: "TRANSIENT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function isTransientError(errors: string[]): boolean {
  const transientPatterns = [/connect/i, /timeout/i, /offline/i, /socket/i, /1954/i];
  return errors.some((err) => transientPatterns.some((p) => p.test(err)));
}
