import { z } from "zod";
import { getJob, listJobs, type JobRecord } from "../core/jobs.js";
import { respond, fail, type ToolResponse } from "../utils/respond.js";

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
      "Jobs live in server memory and are cleared by a restart. Omit jobId to list recent jobs.",
    ]);
  }

  // Completed jobs carry the original tool response — return it verbatim.
  if (
    job.status === "completed" &&
    job.result &&
    typeof job.result === "object" &&
    "content" in (job.result as Record<string, unknown>)
  ) {
    return {
      ...(job.result as ToolResponse),
      jobId: job.id,
    } as ToolResponse;
  }

  if (job.status === "failed") {
    return respond({
      ok: false,
      jobId: job.id,
      name: job.name,
      status: job.status,
      durationMs: job.durationMs ?? null,
      error: job.error ?? "Unknown error",
    });
  }

  return respond({
    ok: true,
    ...summarize(job),
  });
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
