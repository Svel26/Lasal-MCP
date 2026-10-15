import { z } from "zod";
import { getJob, listJobs, type JobRecord } from "../core/jobs.js";
import { respond, fail, type ToolResponse } from "../utils/respond.js";

// ─── check_job_status ─────────────────────────────────────────────────────────
//
// Contract: EVERY response clearly reports the job state.
//  - running  → { status: "running", elapsedMs, … } — keep polling.
//  - finished → an explicit { status: "completed"|"failed", … } envelope as the
//               FIRST content item, followed by the job's original tool result.
// The finished envelope must never be omitted, otherwise agents cannot tell the
// job ended (this was a real field bug: the raw result looked like a polling
// error and agents kept polling the same response).

export const checkJobStatusSchema = {
  jobId: z
    .string()
    .optional()
    .describe("Job id returned by an async tool call (status 'pending'). Omit to list recent jobs."),
};

export async function checkJobStatusHandler(args: { jobId?: string }): Promise<ToolResponse> {
  if (!args.jobId) {
    return respond({
      ok: true,
      jobs: listJobs().map((j) => summarize(j)),
      hint: "Pass jobId for the full result of a specific job.",
    });
  }

  const job = getJob(args.jobId);
  if (!job) {
    return fail(`Unknown job id: ${args.jobId}`, [
      "Job ids live in server memory and are cleared by a restart. Omit jobId to list recent jobs.",
    ]);
  }

  // ── still running ──
  if (job.status === "running") {
    return respond({
      ok: true,
      jobId: job.id,
      name: job.name,
      status: "running",
      startedAt: job.startedAt,
      elapsedMs: Date.now() - job.startedAt,
      hint: "Job is still running — call check_job_status again with this jobId until status is 'completed' or 'failed'.",
    });
  }

  // ── failed (the job function itself threw) ──
  if (job.status === "failed") {
    return respond({
      ok: false,
      jobId: job.id,
      name: job.name,
      status: "failed",
      durationMs: job.durationMs ?? null,
      finishedAt: job.finishedAt ?? null,
      error: job.error ?? "Unknown error",
    });
  }

  // ── completed: explicit status envelope + the original tool result ──
  const innerOk = isToolResponse(job.result) && !isErrorResult(job.result);
  const envelope = {
    ok: innerOk,
    jobId: job.id,
    name: job.name,
    status: "completed" as const,
    durationMs: job.durationMs ?? null,
    finishedAt: job.finishedAt ?? null,
    hint: "Job finished — the original tool result follows as the next content item.",
  };

  const content: Array<Record<string, unknown>> = [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }];

  if (isToolResponse(job.result)) {
    content.push(...(job.result.content as Array<Record<string, unknown>>));
  } else if (job.result !== undefined) {
    content.push({ type: "text" as const, text: JSON.stringify(job.result, null, 2) });
  }

  return { content: content as ToolResponse["content"] };
}

function isToolResponse(value: unknown): value is ToolResponse {
  return !!value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content);
}

function isErrorResult(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { isError?: unknown }).isError === true;
}

function summarize(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}
