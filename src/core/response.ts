import type { BatchResult } from "../utils/batchScript.js";
import type { VisuResult } from "../utils/visuScript.js";
import { respond } from "../utils/respond.js";

export interface StepResult {
  ok: boolean;
  durationMs: number;
  errors?: string[];
  warnings?: string[];
  logTail?: string[];
  logPath?: string;
  hints?: string[];
  timedOut?: boolean;
}

export function batchToStepResult(br: BatchResult): StepResult {
  return {
    ok: br.ok,
    durationMs: br.durationMs,
    ...(br.errors.length ? { errors: br.errors } : {}),
    ...(br.warnings.length ? { warnings: br.warnings } : {}),
    ...(br.logTail.length ? { logTail: br.logTail } : {}),
    logPath: br.logPath,
    hints: br.hints,
    timedOut: br.timedOut,
  };
}

export function visuToStepResult(vr: VisuResult): StepResult {
  return {
    ok: vr.ok,
    durationMs: vr.durationMs,
    ...(vr.errors.length ? { errors: vr.errors } : {}),
    ...(vr.warnings.length ? { warnings: vr.warnings } : {}),
    logPath: vr.logPath,
    hints: vr.hints,
    timedOut: vr.timedOut,
  };
}

export function batchResultToResponse(br: BatchResult, extra?: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    ok: br.ok,
    durationMs: br.durationMs,
    ...(br.errors.length ? { errors: br.errors } : {}),
    ...(br.warnings.length ? { warnings: br.warnings } : {}),
    ...(br.logTail.length ? { logTail: br.logTail } : {}),
    logPath: br.logPath,
    ...(br.hints?.length ? { hints: br.hints } : {}),
    ...extra,
  };
  return respond(body as { ok: boolean });
}
