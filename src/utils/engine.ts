import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { SCRATCH_MAX_AGE_H } from "./config.js";

// ─── Executable Paths ────────────────────────────────────────────────────────

export const VISUDESIGNER_EXE =
  process.env.LASAL_VISUDESIGNER_EXE ||
  "C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe";

export const CLASS2_EXE =
  process.env.LASAL_CLASS2_EXE ||
  "C:\\Program Files (x86)\\Sigmatek\\Lasal\\Class2\\Bin\\Lasal2.exe";

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
    const dirs = readdirSync(root).filter(d => d.startsWith("Lasal VISUDesigner V"));
    const sortedDirs = versionSort(dirs);
    for (const dir of sortedDirs) {
      const parentPath = join(root, dir);
      try {
        const subDirs = readdirSync(parentPath).filter(d => d.startsWith("Lasal VISUDataService V"));
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

function findEdgePath(): string {
  const paths = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return "";
}

export const EDGE_EXE = process.env.LASAL_EDGE_EXE || findEdgePath();

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

// ─── Global Engine Mutex ─────────────────────────────────────────────────────

let currentPromise: Promise<unknown> = Promise.resolve();

export async function withEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = currentPromise.then(fn);
  currentPromise = next.catch(() => {});
  return next;
}
