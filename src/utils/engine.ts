import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { AsyncLocalStorage } from "async_hooks";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { SCRATCH_MAX_AGE_H } from "./config.js";
import { acquireFileLock } from "./fileLock.js";
import { getCurrentProject } from "../state.js";

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

// ─── Process ownership (multi-agent safety) ──────────────────────────────────
//
// Several MCP server processes talk to the same machine. Killing by image name
// destroys another agent's CLASS 2 session (and its unsaved edits). Before
// terminating anything we inspect each process: a CLASS 2 started with an .lcp
// on its command line belongs to exactly that project.

export interface ProcessInfo {
  pid: number;
  commandLine: string;
  title: string;
}

export function getProcessInfos(imageName: string): ProcessInfo[] {
  if (!/^[\w.-]+\.exe$/i.test(imageName)) return [];
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$procs = Get-CimInstance Win32_Process -Filter "Name='${imageName}'"`,
    "$items = @()",
    "foreach ($p in $procs) {",
    "  $gp = Get-Process -Id $p.ProcessId",
    "  $items += [pscustomobject]@{ pid = [int]$p.ProcessId; commandLine = [string]$p.CommandLine; title = [string]$gp.MainWindowTitle }",
    "}",
    "ConvertTo-Json -InputObject @($items) -Compress",
  ].join("\n");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out) as ProcessInfo | ProcessInfo[];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((p) => typeof p?.pid === "number" && p.pid > 0);
  } catch {
    return [];
  }
}

export interface Class2HandleInfo {
  pid: number;
  /** Project file the process was opened with (`.lcp` for CLASS 2, `.lvp` for VISUDesigner). */
  lcpPath: string | null;
  title: string;
}

export class Class2ConflictError extends Error {
  readonly conflicts: Class2HandleInfo[];

  constructor(conflicts: Class2HandleInfo[]) {
    const list = conflicts
      .map((c) => `  PID ${c.pid}: ${c.lcpPath ?? (c.title || "unknown project")}`)
      .join("\n");
    super(
      `A LASAL editor is open for a different project and was left running:\n${list}\n` +
        "Close it first, or call manage_class2 / manage_visudesigner close with force: true to terminate it anyway.",
    );
    this.name = "Class2ConflictError";
    this.conflicts = conflicts;
  }
}

function extractProjectFile(commandLine: string, ext: string): string | null {
  if (!commandLine) return null;
  const escaped = ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = new RegExp(`([A-Za-z]:\\\\[^"]*?${escaped})`, "i");
  const quoted = new RegExp(`"([^"]+${escaped})"`, "i");
  const m = commandLine.match(direct) ?? commandLine.match(quoted);
  if (!m?.[1]) return null;
  try {
    return resolve(m[1]);
  } catch {
    return m[1];
  }
}

function isUnderDir(file: string, dir: string): boolean {
  const f = resolve(file).toLowerCase();
  const d = resolve(dir).toLowerCase().replace(/[\\/]+$/, "");
  return f === d || f.startsWith(`${d}\\`);
}

export function getAppHandles(imageName: string, ext: string): Class2HandleInfo[] {
  return getProcessInfos(imageName).map((p) => ({
    pid: p.pid,
    lcpPath: extractProjectFile(p.commandLine, ext),
    title: p.title,
  }));
}

export interface Class2Scope {
  /** The `.lcp` this operation targets. */
  lcpPath?: string;
  /** Project directory the operation targets (defaults to this agent's selection). */
  projectDir?: string;
}

/**
 * Pure ownership check: no global state, so it is deterministic for tests and
 * for status reporting. Callers that want the current agent's selection must
 * resolve it first (`resolveScope`).
 */
export function findForeignAppHandles(handles: Class2HandleInfo[], scope: Class2Scope = {}): Class2HandleInfo[] {
  const protectedFile = scope.lcpPath ? resolve(scope.lcpPath).toLowerCase() : undefined;
  const protectedDir = scope.projectDir?.replace(/[\\/]+$/, "").toLowerCase();
  if (!protectedFile && !protectedDir) return [];

  return handles.filter((h) => {
    if (!h.lcpPath) {
      // Cannot attribute the process to a project. Treat it as foreign: refusing
      // to kill an unattributed IDE is safer than destroying unsaved work.
      return true;
    }
    const file = h.lcpPath.toLowerCase();
    if (protectedFile && file === protectedFile) return false;
    if (protectedDir && isUnderDir(file, protectedDir)) return false;
    return true;
  });
}

/** Fill in this agent's project selection when the caller did not scope the call. */
function resolveScope(scope: Class2Scope): Class2Scope {
  if (scope.lcpPath || scope.projectDir) return scope;
  const projectDir = getCurrentProject();
  return projectDir ? { projectDir } : {};
}

function getAppConflicts(imageName: string, ext: string, scope: Class2Scope = {}): Class2HandleInfo[] {
  return findForeignAppHandles(getAppHandles(imageName, ext), resolveScope(scope));
}

/**
 * CLASS 2 instances that do not belong to `scope`. Empty when the scope cannot
 * be determined (legacy behaviour: the caller owns every instance).
 */
export function getClass2Conflicts(scope: Class2Scope = {}): Class2HandleInfo[] {
  return getAppConflicts("Lasal2.exe", ".lcp", scope);
}

/** One process enumeration: all CLASS 2 handles plus the ones belonging to other projects. */
export function getClass2Status(scope: Class2Scope = {}): {
  handles: Class2HandleInfo[];
  conflicts: Class2HandleInfo[];
} {
  const handles = getAppHandles("Lasal2.exe", ".lcp");
  return { handles, conflicts: findForeignAppHandles(handles, resolveScope(scope)) };
}

/** VISUDesigner instances that do not belong to `scope`. */
export function getVisuDesignerConflicts(scope: Class2Scope = {}): Class2HandleInfo[] {
  return getAppConflicts("VISUDesigner.exe", ".lvp", scope);
}

export interface KillClass2Options extends Class2Scope {
  /** Kill every CLASS 2 process, including other projects'. */
  force?: boolean;
  /**
   * What to do when another project's CLASS 2 is running:
   * "throw" (default) surfaces the conflict; "skip" leaves it alone silently
   * (used for failure cleanup, where the original error is more useful).
   */
  onConflict?: "throw" | "skip";
}

export interface KillClass2Result {
  killed: number[];
  conflicts: Class2HandleInfo[];
}

function killApp(
  imageName: string,
  ext: string,
  opts: KillClass2Options = {},
): KillClass2Result {
  const handles = getAppHandles(imageName, ext);
  if (handles.length === 0) return { killed: [], conflicts: [] };

  const scope: Class2Scope = { ...(opts.lcpPath ? { lcpPath: opts.lcpPath } : {}) };
  if (opts.projectDir) scope.projectDir = opts.projectDir;
  const conflicts = opts.force ? [] : findForeignAppHandles(handles, resolveScope(scope));

  if (conflicts.length > 0 && opts.onConflict !== "skip") {
    throw new Class2ConflictError(conflicts);
  }

  const conflictPids = new Set(conflicts.map((c) => c.pid));
  const killed: number[] = [];
  for (const h of handles) {
    if (conflictPids.has(h.pid)) continue;
    try {
      execSync(`taskkill /PID ${h.pid} /F /T`, { stdio: "pipe" });
      killed.push(h.pid);
    } catch {
      // Already gone.
    }
  }
  return { killed, conflicts };
}

export function killClass2(opts: KillClass2Options = {}): KillClass2Result {
  return killApp("Lasal2.exe", ".lcp", opts);
}

export function killVisuDesigner(opts: KillClass2Options = {}): KillClass2Result {
  return killApp("VISUDesigner.exe", ".lvp", opts);
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
//
// The engine (Lasal2.exe / VISUDesigner / LSE) is a machine-wide resource and
// several MCP server processes may want it at once. The old in-process promise
// chain only serialized calls inside one server. This lock is a directory in the
// shared scratch folder, so all agents queue on the same resource. Re-entrant
// calls from the same async context (deploy → compile → download) pass straight
// through instead of deadlocking.

const ENGINE_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

const engineLockContext = new AsyncLocalStorage<boolean>();
let engineQueue: Promise<unknown> = Promise.resolve();

export async function withEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  if (engineLockContext.getStore()) return fn();

  const run = engineQueue.then(async () => {
    const release = await acquireFileLock(join(SCRATCH, "engine.lock"), {
      timeoutMs: ENGINE_LOCK_TIMEOUT_MS,
      label: "lasal engine",
    });
    try {
      return await engineLockContext.run(true, fn);
    } finally {
      release();
    }
  });
  engineQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
