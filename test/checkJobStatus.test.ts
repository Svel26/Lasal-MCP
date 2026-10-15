import { describe, it, expect } from "vitest";
import { getJob, startJob } from "../src/core/jobs.js";
import { checkJobStatusHandler } from "../src/tools/checkJobStatus.js";
import { respond } from "../src/utils/respond.js";

function firstJson(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/** Wait until the job leaves the running state instead of sleeping a fixed amount. */
async function waitForSettle(jobId: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (getJob(jobId)?.status !== "running") return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("check_job_status", () => {
  it("reports running jobs with elapsed time (never a bare result)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = startJob("t-running", async () => {
      await gate;
      return "done";
    });

    const res = await checkJobStatusHandler({ jobId: job.id });
    const body = firstJson(res);
    expect(body.status).toBe("running");
    expect(body.jobId).toBe(job.id);
    expect(typeof body.elapsedMs).toBe("number");

    release();
    await waitForSettle(job.id);
  });

  it("completed jobs return an explicit status envelope followed by the original result", async () => {
    const job = startJob("t-complete", async () => respond({ ok: true, steps: { compile: { ok: true } } }));
    await waitForSettle(job.id);

    const res = await checkJobStatusHandler({ jobId: job.id });
    expect(res.content.length).toBeGreaterThanOrEqual(2);

    const envelope = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(envelope.status).toBe("completed");
    expect(envelope.ok).toBe(true);
    expect(envelope.jobId).toBe(job.id);

    const inner = JSON.parse(res.content[1]!.text) as Record<string, unknown>;
    expect(inner.ok).toBe(true);
    expect(inner.steps).toBeTruthy();
  });

  it("completed-with-failure keeps ok=false in the envelope but does not mark the poll as an error", async () => {
    const job = startJob("t-complete-fail", async () => respond({ ok: false, error: "no project selected" }));
    await waitForSettle(job.id);

    const res = await checkJobStatusHandler({ jobId: job.id });
    const envelope = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(envelope.status).toBe("completed");
    expect(envelope.ok).toBe(false);
    expect(res.isError).toBeFalsy();

    const inner = JSON.parse(res.content[1]!.text) as Record<string, unknown>;
    expect(inner.error).toBe("no project selected");
  });

  it("thrown job failures report status failed with the error", async () => {
    const job = startJob("t-throw", async () => {
      throw new Error("boom");
    });
    await waitForSettle(job.id);

    const res = await checkJobStatusHandler({ jobId: job.id });
    const body = firstJson(res);
    expect(body.status).toBe("failed");
    expect(body.ok).toBe(false);
    expect(body.error).toBe("boom");
  });

  it("lists recent jobs when no id is given", async () => {
    const res = await checkJobStatusHandler({});
    const body = firstJson(res);
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it("unknown job ids fail with guidance", async () => {
    const res = await checkJobStatusHandler({ jobId: "does-not-exist" });
    expect(res.isError).toBe(true);
  });
});
