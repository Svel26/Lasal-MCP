import { describe, it, expect, vi } from "vitest";
import { createProgressReporter } from "../src/utils/mcpProgress.js";

describe("createProgressReporter", () => {
  it("sends notifications/progress when a progressToken is provided", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: any = {
      _meta: { progressToken: "token-123" },
      sendNotification,
    };

    const reporter = createProgressReporter(extra, "test.logger");
    await reporter.report(50, 100, "Halfway done");

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: "token-123",
        progress: 50,
        total: 100,
        message: "Halfway done",
      },
    });
  });

  it("does nothing when progressToken is absent", async () => {
    const sendNotification = vi.fn();
    const extra: any = { sendNotification };

    const reporter = createProgressReporter(extra);
    await reporter.report(50, 100, "Ignored");

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends structured logging notifications via sendNotification", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: any = { sendNotification };

    const reporter = createProgressReporter(extra, "lasal.test");
    await reporter.log("warning", "Something unexpected happened");

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/message",
      params: {
        level: "warning",
        data: "Something unexpected happened",
        logger: "lasal.test",
      },
    });
  });

  it("gracefully catches errors if sendNotification fails", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("Connection reset"));
    const extra: any = {
      _meta: { progressToken: "tok" },
      sendNotification,
    };

    const reporter = createProgressReporter(extra);
    await expect(reporter.report(10, 100, "Fail test")).resolves.not.toThrow();
    await expect(reporter.log("error", "Fail log")).resolves.not.toThrow();
  });
});
