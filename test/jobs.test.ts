import { describe, it, expect } from "vitest";
import { startJob, getJob, listJobs } from "../src/core/jobs.js";

describe("job registry", () => {
  it("tracks a successful job to completion with its result", async () => {
    const job = startJob("test-job-ok", async () => ({ done: true, value: 42 }));
    expect(job.status).toBe("running");

    // wait for completion
    for (let i = 0; i < 50 && getJob(job.id)!.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const done = getJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ done: true, value: 42 });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks a failing job with its error", async () => {
    const job = startJob("test-job-fail", async () => {
      throw new Error("boom");
    });

    for (let i = 0; i < 50 && getJob(job.id)!.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const failed = getJob(job.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
  });

  it("lists jobs newest first and returns undefined for unknown ids", async () => {
    const before = listJobs().length;
    const job = startJob("test-job-list", async () => "x");
    for (let i = 0; i < 50 && getJob(job.id)!.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const jobs = listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(before + 1);
    expect(jobs[0]!.id).toBe(job.id);
    expect(getJob("does-not-exist")).toBeUndefined();
  });
});
