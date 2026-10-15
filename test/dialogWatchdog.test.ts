import { describe, it, expect, afterEach } from "vitest";
import { DIALOG_WATCHER_SCRIPT, formatDialogEvents, startDialogWatchdog } from "../src/utils/dialogWatchdog.js";

describe("dialog watchdog", () => {
  const original = process.env.LASAL_MCP_DIALOG_WATCHER;
  afterEach(() => {
    if (original === undefined) delete process.env.LASAL_MCP_DIALOG_WATCHER;
    else process.env.LASAL_MCP_DIALOG_WATCHER = original;
  });

  it("returns a no-op handle when disabled", async () => {
    process.env.LASAL_MCP_DIALOG_WATCHER = "0";
    const watchdog = startDialogWatchdog(1234);
    const events = await watchdog.stop();
    expect(events).toEqual([]);
  });

  it("returns a no-op handle when no pid is available", async () => {
    const watchdog = startDialogWatchdog(undefined);
    const events = await watchdog.stop();
    expect(events).toEqual([]);
  });

  it("embeds the Win32 watcher with the expected markers", () => {
    expect(DIALOG_WATCHER_SCRIPT).toContain("LasalDialogWatch");
    expect(DIALOG_WATCHER_SCRIPT).toContain("EnginePid");
    expect(DIALOG_WATCHER_SCRIPT).toContain("WM_CLOSE");
    expect(DIALOG_WATCHER_SCRIPT).toContain("CrashSender1401");
    expect(DIALOG_WATCHER_SCRIPT).toContain("WerFault");
  });

  it("formats dialog events for tool output", () => {
    const lines = formatDialogEvents([
      {
        pid: 42,
        process: "Lasal2",
        title: "Error",
        text: "Load failed | file missing",
        action: "dismissed (WM_CLOSE)",
      },
    ]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Lasal2");
    expect(lines[0]).toContain("Load failed | file missing");
    expect(lines[0]).toContain("dismissed");
  });
});
