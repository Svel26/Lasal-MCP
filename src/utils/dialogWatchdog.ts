import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SCRATCH } from "./engine.js";

// ─── Headless dialog watchdog ────────────────────────────────────────────────
//
// The LASAL engines are GUI applications: certain errors still raise *modal
// dialogs* (MFC message boxes, crash reporters like CrashSender1401, Windows
// WerFault) even during /script runs. A modal dialog blocks the process until
// someone clicks OK — headless runs then hang until the timeout kills them and
// the actual error text never reaches the caller.
//
// This watchdog runs alongside every engine process, finds dialog windows
// belonging to it (class "#32770", plus the crash reporters), captures their
// text, and dismisses them — so the engine proceeds, the run returns promptly,
// and the dialog content shows up in the tool result. Disable with
// LASAL_MCP_DIALOG_WATCHER=0.

export interface DialogEvent {
  pid: number;
  process: string;
  title: string;
  text: string;
  action: string;
}

export const DIALOG_WATCHER_SCRIPT = `param([int]$EnginePid, [string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class LasalDialogWatch
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);

    private const uint WM_CLOSE = 0x0010;
    private const uint WM_COMMAND = 0x0111;
    private const uint BM_CLICK = 0x00F5;

    private static readonly string[] CrashHandlers = { "CrashSender1401", "WerFault", "CrashRpt" };
    private static readonly Dictionary<IntPtr, int> Attempts = new Dictionary<IntPtr, int>();

    public static List<string> Poll(int targetPid, string[] watchedProcs)
    {
        var results = new List<string>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
            bool isTarget = ((int)pid == targetPid) || (proc.Length > 0 && Array.IndexOf(watchedProcs, proc) >= 0);
            if (!isTarget) return true;
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            if (cls.ToString() != "#32770") return true;

            var title = new StringBuilder(512);
            GetWindowText(hWnd, title, 512);
            var text = new StringBuilder();
            EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lp)
            {
                var ccls = new StringBuilder(64);
                GetClassName(child, ccls, 64);
                string c = ccls.ToString();
                if (c == "Static" || c == "Button" || c == "Edit")
                {
                    var t = new StringBuilder(1024);
                    GetWindowText(child, t, 1024);
                    if (t.Length > 0)
                    {
                        if (text.Length > 0) text.Append(" | ");
                        text.Append(t.ToString().Trim());
                    }
                }
                return true;
            }, IntPtr.Zero);

            int attempt;
            Attempts.TryGetValue(hWnd, out attempt);
            attempt++;
            Attempts[hWnd] = attempt;

            string action;
            if (attempt == 1) { PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); action = "dismissed (WM_CLOSE)"; }
            else if (attempt == 2) { PostMessage(hWnd, WM_COMMAND, (IntPtr)1, IntPtr.Zero); action = "clicked (IDOK)"; }
            else
            {
                IntPtr firstButton = IntPtr.Zero;
                EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lp)
                {
                    var ccls = new StringBuilder(64);
                    GetClassName(child, ccls, 64);
                    if (ccls.ToString() == "Button") { firstButton = child; return false; }
                    return true;
                }, IntPtr.Zero);
                if (firstButton != IntPtr.Zero) { SendMessage(firstButton, BM_CLICK, IntPtr.Zero, IntPtr.Zero); action = "clicked (button)"; }
                else { action = "unresponsive"; }

                if (Array.IndexOf(CrashHandlers, proc) >= 0)
                {
                    try { Process.GetProcessById((int)pid).Kill(); action = "killed"; } catch { }
                }
            }

            if (attempt == 1 || attempt == 3)
            {
                results.Add("{\\"pid\\":" + pid + ",\\"process\\":\\"" + Esc(proc) + "\\",\\"title\\":\\"" + Esc(title.ToString()) + "\\",\\"text\\":\\"" + Esc(text.ToString()) + "\\",\\"action\\":\\"" + Esc(action) + "\\"}");
            }
            return true;
        }, IntPtr.Zero);
        return results;
    }

    private static string Esc(string s)
    {
        if (s == null) return "";
        return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", " ").Replace("\\n", " ");
    }
}
"@
$watched = @('CrashSender1401', 'WerFault', 'CrashRpt')
while ($true) {
  $alive = $false
  try { $null = Get-Process -Id $EnginePid -ErrorAction Stop; $alive = $true } catch { }
  if (-not $alive) { break }
  $lines = [LasalDialogWatch]::Poll($EnginePid, $watched)
  foreach ($l in $lines) { Add-Content -LiteralPath $OutFile -Value $l -Encoding UTF8 }
  Start-Sleep -Milliseconds 600
}
`;

export interface DialogWatchdogHandle {
  stop(): Promise<DialogEvent[]>;
}

/** Start the dialog watchdog beside an engine process. Best-effort: failures return a no-op handle. */
export function startDialogWatchdog(enginePid: number | undefined): DialogWatchdogHandle {
  if (!enginePid || process.env.LASAL_MCP_DIALOG_WATCHER === "0") {
    return { stop: async () => [] };
  }

  const outPath = join(SCRATCH, `dialogs_${enginePid}_${Date.now()}.jsonl`);
  let child: ChildProcess | undefined;
  try {
    if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
    const scriptPath = join(SCRATCH, "dialog_watcher.ps1");
    writeFileSync(scriptPath, `\uFEFF${DIALOG_WATCHER_SCRIPT}`, "utf-8");
    const ps = process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : "powershell.exe";
    // Pipes (drained below) instead of "ignore": with NUL std handles the embedded
    // csc/Add-Type compile inside the watcher is ~9s slower on some machines.
    child = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, String(enginePid), outPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  } catch {
    // watchdog is best-effort
  }

  const readEvents = (): DialogEvent[] => {
    const events: DialogEvent[] = [];
    if (existsSync(outPath)) {
      try {
        for (const line of readFileSync(outPath, "utf-8").split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            events.push(JSON.parse(trimmed) as DialogEvent);
          } catch {
            /* partial line — skip */
          }
        }
      } catch {
        /* ignore */
      }
    }
    return events;
  };

  return {
    stop: async () => {
      // Read BEFORE killing: the watcher may have just dismissed a dialog and
      // its final log line might still be in flight.
      await new Promise((r) => setTimeout(r, 150));
      const first = readEvents();

      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 150));
      const second = readEvents();

      return second.length >= first.length ? second : first;
    },
  };
}

/** Render dialog events for human/agent-readable output. */
export function formatDialogEvents(events: DialogEvent[]): string[] {
  return events.map((d) => `Engine dialog (${d.process}) ${d.action}: ${d.title}${d.text ? ` — ${d.text}` : ""}`);
}
