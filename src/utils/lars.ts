import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { spawn, execSync } from "child_process";
import { join, basename } from "path";
import { homedir } from "os";
import { XMLParser } from "fast-xml-parser";
import { pingHost } from "./preflight.js";
import { updateLssConnection, readLssConnection } from "./projectScanner.js";
import type { LarsInstanceInfo } from "../state.js";

// ─── Executable paths ─────────────────────────────────────────────────────────

export const LARS_EXE =
  process.env.LASAL_LARS_EXE || "C:\\Program Files (x86)\\Sigmatek\\Lars\\Lars.exe";

export const LARS_CONFIG_EXE =
  process.env.LASAL_LARS_CONFIG_EXE ||
  "C:\\Program Files (x86)\\Sigmatek\\Lars\\LARSConfigTool.exe";

export function larsConfigPath(): string {
  return (
    process.env.LASAL_LARS_CONFIG || join(process.env.APPDATA || homedir(), "lasalos2.xml")
  );
}

// ─── Workspace model (lasalos2.xml) ───────────────────────────────────────────

export interface LarsWorkspace {
  name: string;
  onlinePort: number;
  comlinkServerPort: number;
  comlinkBasePort: number;
  alarmPort: number;
  activeData: string;
  autoexec: string;
  lslWork: string;
  sramData: string;
  classProjectPath?: string;
  screenProjectPath?: string;
  dataLenMb: number;
  codeLenMb: number;
}

export const DEFAULT_ONLINE_PORT = 1954;
export const DEFAULT_COMLINK_BASE = 1000;
const PORT_STEP = 10;

function num(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return isNaN(n) ? fallback : n;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function readLarsWorkspaces(): LarsWorkspace[] {
  const path = larsConfigPath();
  if (!existsSync(path)) return [];

  try {
    const raw = readFileSync(path, "utf-8");
    const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false });
    const doc = parser.parse(raw);
    const root = doc.LARSCONFIGURATIONS;
    if (!root) return [];

    const workspaces: LarsWorkspace[] = [];
    for (const ws of asArray<Record<string, unknown>>(root.WORKSPACE)) {
      if (!ws || typeof ws !== "object") continue;
      const name = str(ws["@_Name"], "");
      if (!name) continue;

      const memory = (ws.MEMORY ?? {}) as Record<string, unknown>;
      const pathElem = (ws.PATH ?? {}) as Record<string, unknown>;
      const com = (ws.COMTCP ?? {}) as Record<string, unknown>;

      workspaces.push({
        name,
        onlinePort: num(com.ONLINE, DEFAULT_ONLINE_PORT),
        comlinkServerPort: num(com.COMLINK_SRVR, DEFAULT_ONLINE_PORT + 1),
        comlinkBasePort: num(com.COMLINK, DEFAULT_COMLINK_BASE),
        alarmPort: num(com.ALARM, DEFAULT_ONLINE_PORT + 3),
        activeData: str(pathElem.ACTIVEDAT, "C:\\"),
        autoexec: str(pathElem.AUTOEXEC, "C:\\Autoexec.lsl"),
        lslWork: str(pathElem.LSLWORK, "C:\\LSLWORK"),
        sramData: str(pathElem.SRAMDAT, "C:\\"),
        classProjectPath:
          typeof pathElem.CLASS_PRJ_PATH === "string" ? pathElem.CLASS_PRJ_PATH : undefined,
        screenProjectPath:
          typeof pathElem.SCREEN_PRJ_PATH === "string" ? pathElem.SCREEN_PRJ_PATH : undefined,
        dataLenMb: num(memory.DATALEN, 40),
        codeLenMb: num(memory.CODELEN, 8),
      });
    }
    return workspaces;
  } catch {
    return [];
  }
}

export function writeLarsWorkspaces(workspaces: LarsWorkspace[]): void {
  const path = larsConfigPath();
  const dir = path.substring(0, path.lastIndexOf("\\"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const blocks = workspaces.map((ws) => {
    const mem =
      ws.dataLenMb || ws.codeLenMb
        ? `\t\t<MEMORY>\n\t\t\t<DATALEN Unit="MiB">${ws.dataLenMb}</DATALEN>\n\t\t\t<CODELEN Unit="MiB">${ws.codeLenMb}</CODELEN>\n\t\t</MEMORY>`
        : "\t\t<MEMORY>\n\t\t\t<DATALEN Unit=\"MiB\">40</DATALEN>\n\t\t\t<CODELEN Unit=\"MiB\">8</CODELEN>\n\t\t</MEMORY>";
    const paths = [
      `\t\t\t<ACTIVEDAT>${escapeXml(ws.activeData)}</ACTIVEDAT>`,
      `\t\t\t<AUTOEXEC>${escapeXml(ws.autoexec)}</AUTOEXEC>`,
      `\t\t\t<LSLWORK>${escapeXml(ws.lslWork)}</LSLWORK>`,
      `\t\t\t<SRAMDAT>${escapeXml(ws.sramData)}</SRAMDAT>`,
      ws.classProjectPath
        ? `\t\t\t<CLASS_PRJ_PATH>${escapeXml(ws.classProjectPath)}</CLASS_PRJ_PATH>`
        : "",
      ws.screenProjectPath
        ? `\t\t\t<SCREEN_PRJ_PATH>${escapeXml(ws.screenProjectPath)}</SCREEN_PRJ_PATH>`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const com = [
      `\t\t\t<ONLINE>${ws.onlinePort}</ONLINE>`,
      `\t\t\t<COMLINK_SRVR>${ws.comlinkServerPort}</COMLINK_SRVR>`,
      `\t\t\t<COMLINK>${ws.comlinkBasePort}</COMLINK>`,
      `\t\t\t<ALARM>${ws.alarmPort}</ALARM>`,
    ].join("\n");
    return [
      `\t<WORKSPACE Name="${escapeXml(ws.name)}">`,
      mem,
      `\t\t<PATH>`,
      paths,
      `\t\t</PATH>`,
      `\t\t<COMTCP>`,
      com,
      `\t\t</COMTCP>`,
      `\t\t<RESOLUTION />`,
      `\t\t<DRIVEMAP>`,
      `\t\t\t<DRIVEMAP_ELEMENT>`,
      `\t\t\t\t<DRIVE>C:</DRIVE>`,
      `\t\t\t\t<PATH>${escapeXml(ws.activeData)}</PATH>`,
      `\t\t\t</DRIVEMAP_ELEMENT>`,
      `\t\t</DRIVEMAP>`,
      `\t\t<IP_MAP />`,
      `\t</WORKSPACE>`,
    ].join("\n");
  });

  const content =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<LARSCONFIGURATIONS ConfigVersion="2">\n` +
    blocks.join("\n") +
    `\n</LARSCONFIGURATIONS>\n`;

  if (existsSync(path)) {
    const bak = `${path}.bak`;
    if (!existsSync(bak)) {
      try {
        writeFileSync(bak, readFileSync(path, "utf-8"), "utf-8");
      } catch {}
    }
  }
  writeFileSync(path, content, "utf-8");
}

/** Allocate a unique set of ports for a new workspace (each LARS instance needs distinct ports). */
export function allocateLarsPorts(existing: LarsWorkspace[], baseOnline = DEFAULT_ONLINE_PORT): {
  onlinePort: number;
  comlinkServerPort: number;
  comlinkBasePort: number;
  alarmPort: number;
} {
  const usedOnline = new Set(existing.map((w) => w.onlinePort));
  const usedComlink = new Set(existing.map((w) => w.comlinkBasePort));

  let onlinePort = baseOnline;
  while (usedOnline.has(onlinePort)) onlinePort += PORT_STEP;

  let comlinkBasePort = DEFAULT_COMLINK_BASE;
  while (usedComlink.has(comlinkBasePort)) comlinkBasePort += PORT_STEP;

  return {
    onlinePort,
    comlinkServerPort: onlinePort + 1,
    comlinkBasePort,
    alarmPort: onlinePort + 3,
  };
}

export function upsertLarsWorkspace(
  name: string,
  partial: Partial<LarsWorkspace>
): { workspaces: LarsWorkspace[]; workspace: LarsWorkspace } {
  const workspaces = readLarsWorkspaces();
  let workspace = workspaces.find((w) => w.name === name);

  if (workspace) {
    Object.assign(workspace, partial);
  } else {
    const ports = allocateLarsPorts(workspaces);
    workspace = {
      name,
      onlinePort: ports.onlinePort,
      comlinkServerPort: ports.comlinkServerPort,
      comlinkBasePort: ports.comlinkBasePort,
      alarmPort: ports.alarmPort,
      activeData: "C:\\",
      autoexec: "C:\\Autoexec.lsl",
      lslWork: "C:\\LSLWORK",
      sramData: "C:\\",
      dataLenMb: 40,
      codeLenMb: 8,
      ...partial,
    };
    workspaces.push(workspace);
  }

  writeLarsWorkspaces(workspaces);
  return { workspaces, workspace };
}

export function removeLarsWorkspace(name: string): LarsWorkspace[] {
  const workspaces = readLarsWorkspaces().filter((w) => w.name !== name);
  writeLarsWorkspaces(workspaces);
  return workspaces;
}

// ─── Garbage collection ────────────────────────────────────────────────────────
// Lazy cleanup for auto-created workspaces: a workspace is only GC-eligible
// when it was created by us (tracked in larsInstances state), is not running, and
// nothing points at it anymore — neither the station .lss nor any published DataService
// stations.json. Manually configured workspaces (e.g. DEFAULT from the config tool)
// are never touched.

export interface LarsGcEntry {
  since: number;
}

export interface LarsGcResult {
  removed: Array<{ name: string; onlinePort: number; reason: string }>;
  kept: Array<{ name: string; onlinePort: number; reason: string }>;
  candidates: Array<{ name: string; unreferencedForH: number }>;
  larsGc: Record<string, LarsGcEntry>;
}

export interface LarsGcOptions {
  dryRun?: boolean;
  minAgeH?: number;
  isRunning?: (name: string) => boolean;
  dataDirs?: string[];
  larsGc?: Record<string, LarsGcEntry>;
  instances?: Record<string, LarsInstanceInfo>;
}

function stationTargetsLars(value: string | undefined, onlinePort: number): boolean {
  if (!value) return false;
  const stripped = value.replace(/^TCPIP:/i, "");
  return stripped === `127.0.0.1:${onlinePort}` || stripped.startsWith(`127.0.0.1:${onlinePort}:`);
}

function findStationsJsonFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    const walk = (d: string, depth: number): void => {
      let entries: Array<import("fs").Dirent>;
      try { entries = readdirSync(d, { withFileTypes: true }) as unknown as Array<import("fs").Dirent>; } catch { return; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory() && depth > 0) walk(p, depth - 1);
        else if (e.isFile() && e.name === "stations.json") out.push(p);
      }
    };
    walk(dir, 3);
  }
  return out;
}

function stationsJsonPointsAt(
  file: string,
  stationName: string | undefined,
  stationId: number | undefined,
  onlinePort: number
): boolean {
  try {
    const doc: { stations?: unknown[] } = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(doc?.stations)) return false;
    for (const st of doc.stations) {
      if (!st || typeof st !== "object") continue;
      const stRec = st as Record<string, unknown>;
      const nameOk = stationName !== undefined && stRec.name === stationName;
      const num = typeof stRec.station === "number" ? stRec.station : typeof stRec.station === "string" ? parseInt(stRec.station, 10) : NaN;
      const idOk = stationId !== undefined && stRec.station !== undefined && !isNaN(num) && num === stationId;
      if (!nameOk && !idOk) continue;

      // Published layout: { ip: "127.0.0.1", port: <onlinePort> }
      const ip = typeof stRec.ip === "string" ? stRec.ip : undefined;
      if (ip === "127.0.0.1" && String(stRec.port) === String(onlinePort)) return true;

      // Design-time layout: connection/conType = "127.0.0.1:<onlinePort>"
      const v = typeof stRec.connection === "string" ? stRec.connection : typeof stRec.conType === "string" ? stRec.conType : undefined;
      if (stationTargetsLars(v, onlinePort)) return true;
    }
  } catch {}
  return false;
}

export function gcLarsWorkspaces(opts: LarsGcOptions = {}): LarsGcResult {

  const workspaces = readLarsWorkspaces();
  const instances = opts.instances ?? {};
  const isRunning = opts.isRunning ?? ((name: string) => getLarsPids(name).length > 0);
  const minAgeH = opts.minAgeH ?? 0;
  const now = Date.now();
  const larsGc = { ...(opts.larsGc ?? {}) };
  const removed: LarsGcResult["removed"] = [];
  const kept: LarsGcResult["kept"] = [];
  const candidates: LarsGcResult["candidates"] = [];
  const stationsJsonFiles = findStationsJsonFiles(opts.dataDirs ?? []);

  for (const ws of workspaces) {



    const inst = instances[ws.name];
    let reason: string;
    if (!inst) {
      reason = "manual (no instance bookkeeping) — kept";
    } else if (isRunning(ws.name)) {

      reason = "running";
    } else {
      const lssPoints = inst.stationLssPath
        ? (() => {
          const conn = readLssConnection(inst.stationLssPath);
          return !("error" in conn) && conn.ip === "127.0.0.1" && conn.port === String(ws.onlinePort);
        })()
        : false;
      const dsPoints = (inst.stationName !== undefined || inst.stationId !== undefined)
        ? stationsJsonFiles.some((f) => stationsJsonPointsAt(f, inst.stationName, inst.stationId, ws.onlinePort))
        : false;
      reason = lssPoints || dsPoints ? "referenced (station .lss or DataService stations.json points at it)" : "unreferenced";
    }

    if (reason !== "unreferenced") {

      delete larsGc[ws.name];
      kept.push({ name: ws.name, onlinePort: ws.onlinePort, reason });
    } else {
      const since = larsGc[ws.name]?.since ?? now;
      const ageH = (now - since) / 3_600_000;
      if (ageH >= minAgeH) {

        if (!opts.dryRun) {

          removeLarsWorkspace(ws.name);
          delete larsGc[ws.name];
        }
        removed.push({ name: ws.name, onlinePort: ws.onlinePort, reason: `unreferenced for ${ageH.toFixed(1)}h` });
      } else {
        if (!opts.dryRun) larsGc[ws.name] = { since };
        candidates.push({ name: ws.name, unreferencedForH: Number(ageH.toFixed(2)) });
        kept.push({ name: ws.name, onlinePort: ws.onlinePort, reason: "unreferenced — below min age" });
      }
    }
  }
  return { removed, kept, candidates, larsGc };
}

// ─── Process management ───────────────────────────────────────────────────────

export function getLarsPids(name?: string): number[] {
  try {
    const filter = name
      ? ` | Where-Object { $_.MainWindowTitle -like '*${name}*' }`
      : "";
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process -Name Lars -ErrorAction SilentlyContinue${filter} | Select-Object -ExpandProperty Id"`,
      { encoding: "utf-8" }
    );
    return out
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

export function killLars(name?: string): void {
  for (const pid of getLarsPids(name)) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: "pipe" });
    } catch {}
  }
}

export interface LarsStartResult {
  pid: number | null;
  running: boolean;
  healthy: boolean;
  error?: string;
}

/** Launch a LARS instance for the given workspace. */
export async function startLars(workspace: LarsWorkspace): Promise<LarsStartResult> {
  if (!existsSync(LARS_EXE)) {
    return { pid: null, running: false, healthy: false, error: `LARS not found at ${LARS_EXE}` };
  }
  if (getLarsPids(workspace.name).length > 0) {
    const healthy = await pingHost("127.0.0.1", workspace.onlinePort, 1000);
    return { pid: null, running: true, healthy };
  }

  const config = larsConfigPath();
  // NOTE: no embedded quotes in the args — Node's spawn does not escape inner
  // quotes and would mangle `/c"C:\...xml"`; pass the raw path and let libuv quote.
  const args = [`/c${config}`, `/n${workspace.name}`, "/sWIN"];
  // LARS locates its runtime files (autoexec.lsl, lsldata, ...) relative to the
  // install directory — NOT the workspace's data dir. Use the exe's dir as cwd.
  const installDir = LARS_EXE.substring(0, LARS_EXE.lastIndexOf("\\"));
  try {
    const child = spawn(LARS_EXE, args, {
      cwd: installDir,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    const pid = child.pid ?? null;
    child.unref();
    return { pid, running: true, healthy: false };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { pid: null, running: false, healthy: false, error: msg };
  }
}

export function isLarsHealthy(onlinePort: number, timeoutMs = 1000): Promise<boolean> {
  return pingHost("127.0.0.1", onlinePort, timeoutMs);
}

// ─── Station targeting ────────────────────────────────────────────────────────

/**
 * Point a station's .lss TCPIP profile at a local LARS instance (127.0.0.1:<onlinePort>).
 * Returns the previous connection so it can be restored later.
 */
export function pointStationAtLars(
  lssPath: string,
  onlinePort: number
): { previousIp: string; previousPort: string } | { error: string } {
  const current = readLssConnection(lssPath);
  if ("error" in current) {
    // Station has no TCPIP profile yet — insert one pointing at LARS.
    updateLssConnection(lssPath, { ip: "127.0.0.1", port: String(onlinePort) });
    return { previousIp: "", previousPort: "" };
  }
  updateLssConnection(lssPath, { ip: "127.0.0.1", port: String(onlinePort) });
  return { previousIp: current.ip, previousPort: current.port };
}

export function safeWorkspaceName(projectName: string, stationName: string): string {
  const clean = (s: string) =>
    s.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[0-9]+/, "_");
  return `${clean(projectName)}_${clean(stationName)}`;
}

export function projectDisplayName(projectDir: string): string {
  return basename(projectDir);
}

// ─── DataService stations.json mapping ────────────────────────────────────────

interface DataServiceStation {
  name?: unknown;
  station?: unknown;
  ip?: unknown;
  port?: unknown;
  connection?: unknown;
  conType?: unknown;
  [key: string]: unknown;
}

export interface LarsStationMapping {
  station: string;
  from: string;
  to: string;
}

/**
 * Rewrite a published DataService stations.json so hardware-targeted stations
 * point at a running local LARS instance (127.0.0.1:<onlinePort>).
 *
 * Two layouts are handled:
 *  - design-time layout: `{ name, connection: "TCPIP:10.0.0.5:1964" }` (or `conType`)
 *  - published runtime layout: `{ station: 10, ip: "10.195.0.10", conType: "TCP" }`
 *    (the DataService stores the target IP in `ip`; the port is carried separately)
 *
 * "INTERN"/"LOCAL" connections and stations without a matching LARS instance
 * are left untouched.
 */
export function mapStationsToLars(
  stations: Array<DataServiceStation>,
  larsInstances: Record<string, LarsInstanceInfo>,
  isRunning: (name: string) => boolean = (name) => getLarsPids(name).length > 0
): LarsStationMapping[] {
  const runningByName = new Map<string, LarsInstanceInfo>();
  const runningById = new Map<number, LarsInstanceInfo>();
  for (const inst of Object.values(larsInstances)) {
    if (!isRunning(inst.name)) continue;
    if (inst.stationName) runningByName.set(inst.stationName, inst);
    if (inst.stationId !== undefined) runningById.set(inst.stationId, inst);
  }
  if (runningByName.size === 0 && runningById.size === 0) return [];

  const changed: LarsStationMapping[] = [];
  for (const st of stations) {
    const name = typeof st.name === "string" ? st.name : undefined;
    const num = typeof st.station === "number" ? st.station : typeof st.station === "string" ? parseInt(st.station, 10) : NaN;
    const inst = (name && runningByName.get(name)) ?? (!isNaN(num) && runningById.get(num));
    if (!inst) continue;

    const to = `127.0.0.1:${inst.onlinePort}`;

    // Published runtime layout: { station, ip, conType }
    const ip = typeof st.ip === "string" ? st.ip : undefined;
    if (ip !== undefined) {
      const isHardwareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith("127.");
      if (!isHardwareIp) continue;
      st.ip = "127.0.0.1";
      st.port = inst.onlinePort;
      changed.push({ station: name ?? String(num), from: ip, to });
      continue;
    }

    // Design-time layout: { name, connection | conType }
    const field = typeof st.connection === "string" ? "connection" : typeof st.conType === "string" ? "conType" : undefined;
    if (!field) continue;
    const value = String(st[field]);
    const isHardwareTarget = /^TCPIP:/i.test(value) || /^\d{1,3}(\.\d{1,3}){3}/.test(value);
    if (!isHardwareTarget) continue;

    st[field] = to;
    changed.push({ station: name ?? String(num), from: value, to });
  }
  return changed;
}

// ─── Compile-target switching (ARM → PC for LARS) ─────────────────────────────

export interface TargetSwitchResult {
  previousTag: string;
  newTag: string;
}

/**
 * LARS is an x86 (PC) runtime. Projects compiled with <Target Processor="ARM">
 * are rejected by LARS with a checksum error. Switching the project's compile
 * target to PC (removing the Processor attribute, byte-preserving) makes
 * batch.Compile produce an x86 image LARS can run. Restore with restoreProjectTarget.
 */
export function switchProjectTargetToPC(lcpPath: string): TargetSwitchResult | { error: string } {
  const raw = readFileSync(lcpPath, "latin1");
  const m = raw.match(/<Target\s[^>]*?>/);
  if (!m) return { error: `No <Target ...> element found in ${lcpPath}` };
  const tag = m[0]!;
  if (!/\bProcessor\s*=\s*"ARM"/.test(tag)) {
    return { error: `Project is not ARM-targeted (tag: "${tag}") — nothing to switch.` };
  }
  const newTag = tag.replace(/\s+Processor\s*=\s*"ARM"/, "");
  if (newTag === tag) return { error: `Failed to remove Processor="ARM" from ${lcpPath}` };
  writeFileSync(lcpPath, raw.replace(tag, newTag), "latin1");
  return { previousTag: tag, newTag };
}

export function restoreProjectTarget(lcpPath: string, previousTag: string): boolean {
  const raw = readFileSync(lcpPath, "latin1");
  const m = raw.match(/<Target\s[^>]*?>/);
  if (!m) return false;
  writeFileSync(lcpPath, raw.replace(m[0]!, previousTag), "latin1");
  return true;
}