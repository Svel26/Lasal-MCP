import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { SCRATCH_MAX_AGE_H } from "./config.js";

// ─── Executable Paths ────────────────────────────────────────────────────────

export const VISUDESIGNER_EXE =
  process.env.LASAL_VISUDESIGNER_EXE || "C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe";

export const CLASS2_EXE =
  process.env.LASAL_CLASS2_EXE || "C:\\Program Files (x86)\\Sigmatek\\Lasal\\Class2\\Bin\\Lasal2.exe";

/** LASAL Screen (LSE) editor — also the out-of-process COM automation server for `.lpr` projects. */
export const LASAL_SCREEN_EXE =
  process.env.LASAL_SCREEN_EXE || "C:\\Program Files (x86)\\Sigmatek\\Lasal\\Screen\\LSE_modeless.exe";

/** MachineManager — multi-station deploy orchestrator executing `.lutc` update files. */
export const MACHINEMANAGER_EXE =
  process.env.LASAL_MACHINEMANAGER_EXE ||
  "C:\\Program Files (x86)\\Sigmatek\\Lasal\\MachineManager\\Bin\\MachineManager.exe";

/** LASAL Screen automation contract (registered by the LSE registration dialog). */
export const LSE_PROGID = "LASALScreen.Application";
export const LSE_CLSID = "{82A49236-710D-4A68-8D66-1FC2312CABAB}";

function extractVersion(name: string): number[] {
  const m = name.match(/V(\d+(?:_\d+)*)/);
  if (!m?.[1]) return [0];
  return m[1].split("_").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionSort(names: string[]): string[] {
  return [...names].sort((a, b) => compareVersions(extractVersion(a), extractVersion(b)));
}

export function resolveDataServiceExe(): { path: string; searched: string[] } {
  if (process.env.LASAL_DATASERVICE_EXE) {
    return { path: process.env.LASAL_DATASERVICE_EXE, searched: [] };
  }
  const root = "C:\\Program Files";
  const searched: string[] = [];

  if (!existsSync(root)) {
    return { path: "", searched: [`${root} (does not exist)`] };
  }

  try {
    const dirs = readdirSync(root).filter((d) => d.startsWith("Lasal VISUDesigner V"));
    const sortedDirs = versionSort(dirs);
    for (const dir of sortedDirs) {
      const parentPath = join(root, dir);
      try {
        const subDirs = readdirSync(parentPath).filter((d) => d.startsWith("Lasal VISUDataService V"));
        const sortedSubDirs = versionSort(subDirs);
        for (const subDir of sortedSubDirs) {
          const exePath = join(parentPath, subDir, "Windows", "LasalVISUDataService.exe");
          searched.push(exePath);
          if (existsSync(exePath)) {
            return { path: exePath, searched };
          }
        }
      } catch {}
    }
    if (dirs.length === 0) {
      searched.push(`${root} (no 'Lasal VISUDesigner V*' directories found)`);
    }
  } catch {}

  return { path: "", searched };
}

const _dsResolved = resolveDataServiceExe();
export const DATASERVICE_EXE = _dsResolved.path;
export const DATASERVICE_SEARCHED = _dsResolved.searched;

// ─── Scratch Directory & Cleanup ─────────────────────────────────────────────

export const SCRATCH = join(tmpdir(), "lasal-mcp");

export function cleanupScratch(): void {
  if (!existsSync(SCRATCH)) return;
  try {
    const files = readdirSync(SCRATCH);
    const now = Date.now();
    const cutoff = SCRATCH_MAX_AGE_H * 60 * 60 * 1000;
    for (const file of files) {
      const filePath = join(SCRATCH, file);
      try {
        const stats = statSync(filePath);
        if (now - stats.mtimeMs > cutoff) {
          unlinkSync(filePath);
        }
      } catch {
        // Ignore single file deletion failures
      }
    }
  } catch {
    // Ignore folder reading failures
  }
}

// ─── Centralized Process Killing & Status ────────────────────────────────────

export function isProcessRunning(imageName: string): boolean {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /NH`, { stdio: "pipe", encoding: "utf-8" });
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

export function getProcessPid(imageName: string): number | undefined {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, { stdio: "pipe", encoding: "utf-8" });
    const m = out.match(/"([^"]+)"\s*,\s*"(\d+)"/);
    if (m && m[1] && m[2] && m[1].toLowerCase() === imageName.toLowerCase()) {
      return parseInt(m[2]);
    }
  } catch {}
  return undefined;
}

export function killClass2(): void {
  try {
    execSync(`taskkill /IM "Lasal2.exe" /F /T`, { stdio: "pipe" });
  } catch {
    // Not running
  }
}

export function killVisuDesigner(): void {
  try {
    execSync(`taskkill /IM "VISUDesigner.exe" /F /T`, { stdio: "pipe" });
  } catch {
    // Not running
  }
}

export function killDataService(pid?: number): void {
  if (pid) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: "pipe" });
    } catch {
      // Failed to kill by PID
    }
  } else {
    try {
      execSync(`taskkill /IM "LasalVISUDataService.exe" /F /T`, { stdio: "pipe" });
    } catch {
      // Not running
    }
  }
}

export function killLasalScreen(): void {
  try {
    execSync(`taskkill /IM "LSE_modeless.exe" /F /T`, { stdio: "pipe" });
  } catch {
    // Not running
  }
}

export function killMachineManager(): void {
  try {
    execSync(`taskkill /IM "MachineManager.exe" /F /T`, { stdio: "pipe" });
  } catch {
    // Not running
  }
}

// ─── LASAL Screen COM registration ────────────────────────────────────────────
//
// LSE registers `LASALScreen.Application` (LocalServer32 → LSE_modeless.exe) as a
// 32-bit out-of-process automation server. Clients must be launched with the
// matching bitness for the CLSID lookup to succeed — hence the explicit view
// probe + per-bitness PowerShell host selection.

export interface LseRegistration {
  registered: boolean;
  view: "32" | "64" | null;
  serverExe?: string;
}

let lseRegistrationCache: LseRegistration | undefined;

export function getLseRegistration(): LseRegistration {
  if (lseRegistrationCache) return lseRegistrationCache;
  const views: Array<{ view: "32" | "64"; flag: string }> = [
    { view: "32", flag: "/reg:32" },
    { view: "64", flag: "/reg:64" },
  ];
  for (const { view, flag } of views) {
    try {
      const out = execSync(`reg query "HKLM\\SOFTWARE\\Classes\\CLSID\\${LSE_CLSID}\\LocalServer32" ${flag}`, {
        stdio: "pipe",
        encoding: "utf-8",
      });
      const m = out.match(/REG_SZ\s+(.+)/);
      const serverExe = m?.[1]?.trim().replace(/^"|"$/g, "");
      if (serverExe) {
        lseRegistrationCache = { registered: true, view, serverExe };
        return lseRegistrationCache;
      }
    } catch {
      // Try the next view
    }
  }
  lseRegistrationCache = { registered: false, view: null };
  return lseRegistrationCache;
}

/** Path of the Windows PowerShell host matching the LSE registration bitness. */
export function lsePowerShellPath(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  const rel = "\\WindowsPowerShell\\v1.0\\powershell.exe";
  const view = getLseRegistration().view ?? "32";
  return view === "32" ? `${root}\\SysWOW64${rel}` : `${root}\\System32${rel}`;
}

// ─── Global Engine Mutex ─────────────────────────────────────────────────────

let currentPromise: Promise<unknown> = Promise.resolve();

export async function withEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = currentPromise.then(fn);
  currentPromise = next.catch(() => {});
  return next;
}
