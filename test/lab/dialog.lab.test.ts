import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { startDialogWatchdog } from "../../src/utils/dialogWatchdog.js";

// Live Win32 test: spawns a blocking MessageBox and verifies the watchdog
// auto-dismisses it so headless runs never hang on modal dialogs.
// Run via: npm run test:lab
const ENABLED = process.env.LASAL_LAB === "1";
const d = ENABLED ? describe : describe.skip;

d("LAB: dialog watchdog (live)", () => {
  it("auto-dismisses a modal message box of the watched process", async () => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('lasal-mcp lab dialog','lasal-mcp lab dialog test') | Out-Null; exit 0",
      ],
      { windowsHide: false },
    );
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    const watchdog = startDialogWatchdog(child.pid);

    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 25000))]);
    const events = await watchdog.stop();
    try {
      child.kill();
    } catch {
      /* ignore */
    }

    expect(code, "dialog was not dismissed before the fallback timeout").not.toBeNull();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => /lasal-mcp lab dialog/.test(`${e.title} ${e.text}`))).toBe(true);
  }, 40000);
});
