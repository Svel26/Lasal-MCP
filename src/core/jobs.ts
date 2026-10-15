import { randomUUID } from "crypto";

// ─── Background job registry ──────────────────────────────────────────────────
//
// Long-running operations (deploy_all, deploy_solution, build_project,
// lse_project) can be started asynchronously. The job runs through the regular
// engine lock; `check_job_status` reports state and delivers the final tool
// response. Jobs live in server memory — a restart clears them.

export type JobStatus = "running" | "completed" | "failed";

export interface JobRecord {
  id: string;
  name: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, JobRecord>();
const MAX_JOBS = 40;

export function startJob(name: string, fn: () => Promise<unknown>): JobRecord {
  if (jobs.size >= MAX_JOBS) {
    const finished = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
    for (const j of finished.slice(0, finished.length - 20)) jobs.delete(j.id);
  }

  const job: JobRecord = { id: randomUUID(), name, status: "running", startedAt: Date.now() };
  jobs.set(job.id, job);

  void fn()
    .then((result) => {
      job.status = "completed";
      job.result = result;
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - job.startedAt;
    })
    .catch((e: unknown) => {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - job.startedAt;
    });

  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function listJobs(): JobRecord[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}
