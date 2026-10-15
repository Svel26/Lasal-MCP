import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { spawn, execSync } from "child_process";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { XMLParser } from "fast-xml-parser";
import { pingHost } from "./preflight.js";
import { updateLssConnection, readLssConnection } from "./projectScanner.js";
import { SCRATCH } from "./engine.js";
import type { LarsInstanceInfo } from "../state.js";

// ─── Executable paths ─────────────────────────────────────────────────────────

export const LARS_EXE = process.env.LASAL_LARS_EXE || "C:\\Program Files (x86)\\Sigmatek\\Lars\\Lars.exe";

export const LARS_CONFIG_EXE =
  process.env.LASAL_LARS_CONFIG_EXE || "C:\\Program Files (x86)\\Sigmatek\\Lars\\LARSConfigTool.exe";

export function larsConfigPath(): string {
  return process.env.LASAL_LARS_CONFIG || join(process.env.APPDATA || homedir(), "lasalos2.xml");
}

// ─── Workspace model (lasalos2.xml) ───────────────────────────────────────────

export interface LarsWorkspace {
  name: string;
  onlinePort: number;
  comlinkServerPort: number;
  comlinkBasePort: number;
  alarmPort: number;
  dataServiceTcpPort?: number;
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

/**
 * fast-xml-parser returns `{ "#text": value, "@_Attr": ... }` for elements that carry
 * attributes — LARSConfigTool writes `Desc` attributes on every COMTCP entry, so a raw
 * `String(v)` would stringify the object and silently fall back to defaults. Unwrap the
 * text node before interpreting a scalar element.
 */
function scalar(v: unknown): unknown {
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>)["#text"];
  }
  return v;
}

function num(v: unknown, fallback: number): number {
  const n = parseInt(String(scalar(v) ?? ""), 10);
  return isNaN(n) ? fallback : n;
}

function str(v: unknown, fallback: string): string {
  const s = scalar(v);
  return typeof s === "string" && s.length > 0 ? s : fallback;
}

function strOpt(v: unknown): string | undefined {
  const s = scalar(v);
  return typeof s === "string" && s.length > 0 ? s : undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
        dataServiceTcpPort: num(com.DATASERVICETCPPORT, 2402),
        activeData: str(pathElem.ACTIVEDAT, "C:\\"),
        autoexec: str(pathElem.AUTOEXEC, "C:\\Autoexec.lsl"),
        lslWork: str(pathElem.LSLWORK, "C:\\LSLWORK"),
        sramData: str(pathElem.SRAMDAT, "C:\\"),
        classProjectPath: strOpt(pathElem.CLASS_PRJ_PATH),
        screenProjectPath: strOpt(pathElem.SCREEN_PRJ_PATH),
        dataLenMb: num(memory.DATALEN, 40),
        codeLenMb: num(memory.CODELEN, 8),
      });
    }
    return workspaces;
  } catch {
    return [];
  }
}

// ─── Writing (lossless merge) ─────────────────────────────────────────────────
//
// LARSConfigTool and this server both edit %APPDATA%\lasalos2.xml. Regenerating
// the whole file would drop fields the tool writes but this server does not model
// (Desc attributes, DATASERVICETCPPORT values, future additions). Writes therefore
// merge surgically: existing workspace blocks are copied verbatim except for the
// fields we own, everything else (unknown elements, attributes, comments, extra
// drive mappings) is preserved, and only genuinely new workspaces get a canonical
// block appended. A full canonical file is generated only when no parseable config
// exists yet.

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/** Replace the text of an element, preserving its attributes. No-op when the element is absent. */
function replaceElementText(block: string, tag: string, value: string): string {
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(</${tag}>)`);
  if (!re.test(block)) return block;
  return block.replace(re, (_m, open: string, _old: string, close: string) => `${open}${escapeXml(value)}${close}`);
}

function hasElement(block: string, tag: string): boolean {
  return new RegExp(`<${tag}\\b`).test(block);
}

/** Insert a child element before the container's closing tag, using the container's indentation. */
function insertChildElement(block: string, container: string, tag: string, value: string): string {
  const re = new RegExp(`^([ \\t]*)</${container}>`, "m");
  const m = re.exec(block);
  if (!m) return block;
  const indent = m[1] ?? "\t\t";
  const child = `${indent}\t<${tag}>${escapeXml(value)}</${tag}>\n${indent}</${container}>`;
  return block.replace(re, () => child);
}

/** Replace the element if present, otherwise insert it into the container. */
function ensureElementText(block: string, container: string, tag: string, value: string): string {
  const replaced = replaceElementText(block, tag, value);
  if (replaced !== block || hasElement(block, tag)) return replaced;
  return insertChildElement(block, container, tag, value);
}

/** Update only the model-owned fields of an existing workspace block. */
function updateWorkspaceBlock(block: string, ws: LarsWorkspace): string {
  let out = block;
  out = replaceElementText(out, "DATALEN", String(ws.dataLenMb));
  out = replaceElementText(out, "CODELEN", String(ws.codeLenMb));
  out = replaceElementText(out, "ACTIVEDAT", ws.activeData);
  out = replaceElementText(out, "AUTOEXEC", ws.autoexec);
  out = replaceElementText(out, "LSLWORK", ws.lslWork);
  out = replaceElementText(out, "SRAMDAT", ws.sramData);
  if (ws.classProjectPath) out = ensureElementText(out, "PATH", "CLASS_PRJ_PATH", ws.classProjectPath);
  if (ws.screenProjectPath) out = ensureElementText(out, "PATH", "SCREEN_PRJ_PATH", ws.screenProjectPath);
  out = replaceElementText(out, "ONLINE", String(ws.onlinePort));
  out = replaceElementText(out, "COMLINK_SRVR", String(ws.comlinkServerPort));
  out = replaceElementText(out, "COMLINK", String(ws.comlinkBasePort));
  out = replaceElementText(out, "ALARM", String(ws.alarmPort));
  // Replace-only (never insert): an absent DATASERVICETCPPORT means the LARS default, so
  // the lossless merge leaves the file's shape untouched.
  out = replaceElementText(out, "DATASERVICETCPPORT", String(ws.dataServiceTcpPort ?? 2402));
  // Retarget only the C: drive mapping; additional mappings are preserved.
  return out.replace(
    /(<DRIVEMAP_ELEMENT>\s*<DRIVE>C:<\/DRIVE>\s*<PATH>)([\s\S]*?)(<\/PATH>)/i,
    (_m, open: string, _old: string, close: string) => `${open}${escapeXml(ws.activeData)}${close}`,
  );
}

/** Canonical workspace block — used for brand-new workspaces and first-time files. */
function buildWorkspaceBlock(ws: LarsWorkspace): string {
  const mem =
    ws.dataLenMb || ws.codeLenMb
      ? `\t\t<MEMORY>\n\t\t\t<DATALEN Unit="MiB">${ws.dataLenMb}</DATALEN>\n\t\t\t<CODELEN Unit="MiB">${ws.codeLenMb}</CODELEN>\n\t\t</MEMORY>`
      : '\t\t<MEMORY>\n\t\t\t<DATALEN Unit="MiB">40</DATALEN>\n\t\t\t<CODELEN Unit="MiB">8</CODELEN>\n\t\t</MEMORY>';
  const paths = [
    `\t\t\t<ACTIVEDAT>${escapeXml(ws.activeData)}</ACTIVEDAT>`,
    `\t\t\t<AUTOEXEC>${escapeXml(ws.autoexec)}</AUTOEXEC>`,
    `\t\t\t<LSLWORK>${escapeXml(ws.lslWork)}</LSLWORK>`,
    `\t\t\t<SRAMDAT>${escapeXml(ws.sramData)}</SRAMDAT>`,
    ws.classProjectPath ? `\t\t\t<CLASS_PRJ_PATH>${escapeXml(ws.classProjectPath)}</CLASS_PRJ_PATH>` : "",
    ws.screenProjectPath ? `\t\t\t<SCREEN_PRJ_PATH>${escapeXml(ws.screenProjectPath)}</SCREEN_PRJ_PATH>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // Emit the same canonical shape as LARSConfigTool (Desc attributes + DATASERVICETCPPORT).
  const com = [
    `\t\t\t<ONLINE Desc="Port for the online comunication.">${ws.onlinePort}</ONLINE>`,
    `\t\t\t<COMLINK_SRVR Desc="Comlink command server port.">${ws.comlinkServerPort}</COMLINK_SRVR>`,
    `\t\t\t<COMLINK Desc="Base port number used for clients.">${ws.comlinkBasePort}</COMLINK>`,
    `\t\t\t<ALARM Desc="Alarm-Server port of the LSE-Kernel.">${ws.alarmPort}</ALARM>`,
    `\t\t\t<DATASERVICETCPPORT Desc="Datalink-Server port of the LSE-Kernel.">${ws.dataServiceTcpPort ?? 2402}</DATASERVICETCPPORT>`,
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
    `\t\t<RESOLUTION></RESOLUTION>`,
    `\t\t<DRIVEMAP>`,
    `\t\t\t<DRIVEMAP_ELEMENT>`,
    `\t\t\t\t<DRIVE>C:</DRIVE>`,
    `\t\t\t\t<PATH>${escapeXml(ws.activeData)}</PATH>`,
    `\t\t\t</DRIVEMAP_ELEMENT>`,
    `\t\t</DRIVEMAP>`,
    `\t\t<IP_MAP>`,
    `\t\t</IP_MAP>`,
    `\t</WORKSPACE>`,
  ].join("\n");
}

function buildFullConfig(workspaces: LarsWorkspace[]): string {
  const blocks = workspaces.map((ws) => buildWorkspaceBlock(ws));
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<LARSCONFIGURATIONS ConfigVersion="2">\n` +
    blocks.join("\n") +
    `\n</LARSCONFIGURATIONS>\n`
  );
}

/** Merge the desired workspace list into the raw config, preserving foreign content. Returns null when the raw file cannot be merged. */
function mergeWorkspaceConfig(raw: string, workspaces: LarsWorkspace[]): string | null {
  const rootClose = raw.lastIndexOf("</LARSCONFIGURATIONS>");
  if (rootClose < 0) return null;

  const wanted = new Map(workspaces.map((w) => [w.name, w]));
  const seen = new Set<string>();
  const re = /<WORKSPACE\b[^>]*>[\s\S]*?<\/WORKSPACE>/g;

  let out = "";
  let cursor = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    matched = true;
    out += raw.slice(cursor, m.index);
    cursor = m.index + m[0].length;

    const nameAttr = m[0].match(/<WORKSPACE\b[^>]*\bName\s*=\s*"([^"]*)"/i)?.[1];
    if (nameAttr === undefined) {
      out += m[0]; // unidentified block — keep verbatim rather than risk losing data
      continue;
    }
    const ws = wanted.get(unescapeXml(nameAttr));
    if (!ws) continue; // removed workspace: drop the block
    seen.add(ws.name);
    out += updateWorkspaceBlock(m[0], ws);
  }
  if (!matched && workspaces.length > 0) return null;
  out += raw.slice(cursor);

  const additions = workspaces.filter((w) => !seen.has(w.name));
  if (additions.length > 0) {
    const idx = out.lastIndexOf("</LARSCONFIGURATIONS>");
    const blocks = additions.map((ws) => buildWorkspaceBlock(ws)).join("\n");
    out = out.slice(0, idx) + blocks + "\n" + out.slice(idx);
  }
  return out;
}

export function writeLarsWorkspaces(workspaces: LarsWorkspace[]): void {
  const path = larsConfigPath();
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(path)) {
    const bak = `${path}.bak`;
    if (!existsSync(bak)) {
      try {
        writeFileSync(bak, readFileSync(path, "utf-8"), "utf-8");
      } catch {}
    }
  }

  const merged = existsSync(path) ? mergeWorkspaceConfig(readFileSync(path, "utf-8"), workspaces) : null;
  writeFileSync(path, merged ?? buildFullConfig(workspaces), "utf-8");
}

/** Allocate a unique set of ports for a new workspace (each LARS instance needs distinct ports). */
export function allocateLarsPorts(
  existing: LarsWorkspace[],
  baseOnline = DEFAULT_ONLINE_PORT,
): {
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
  partial: Partial<LarsWorkspace>,
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
      dataServiceTcpPort: 2402,
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
  /** Project directories whose workspaces must never be auto-collected (e.g. the selected project). */
  protectProjects?: string[];
}

/** Normalize a directory path for comparison: separators unified, trailing slashes dropped, case-insensitive. */
export function normalizeProjectDir(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * True when a LARS instance belongs to `projectDir`. Uses the recorded projectDir and falls
 * back to the .lcp/.lss paths for legacy bookkeeping written before projectDir was stored.
 */
export function instanceBelongsToProject(inst: LarsInstanceInfo, projectDir: string | null | undefined): boolean {
  if (!projectDir) return false;
  const target = normalizeProjectDir(projectDir);
  if (!target) return false;
  if (inst.projectDir && normalizeProjectDir(inst.projectDir) === target) return true;
  for (const p of [inst.lcpPath, inst.stationLssPath]) {
    if (p && normalizeProjectDir(p).startsWith(`${target}\\`)) return true;
  }
  return false;
}

export interface StationInstanceLookup {
  /** Instances matching the station name inside the requested project (all matches when no project is known). */
  matches: LarsInstanceInfo[];
  /** Instances with the same station name that belong to a different project. */
  foreign: LarsInstanceInfo[];
}

/**
 * Find LARS instances for a station name, scoped to `projectDir` when one is known.
 * Never silently falls back to another project's workspace: those land in `foreign`.
 */
export function findLarsInstancesForStation(
  instances: Record<string, LarsInstanceInfo> | undefined,
  station: string,
  projectDir?: string | null,
): StationInstanceLookup {
  const all = Object.values(instances ?? {}).filter((i) => i.stationName === station);
  if (!projectDir) return { matches: all, foreign: [] };
  const matches = all.filter((i) => instanceBelongsToProject(i, projectDir));
  return { matches, foreign: all.filter((i) => !instanceBelongsToProject(i, projectDir)) };
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
      try {
        entries = readdirSync(d, { withFileTypes: true }) as unknown as Array<import("fs").Dirent>;
      } catch {
        return;
      }
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
  onlinePort: number,
): boolean {
  try {
    const doc: { stations?: unknown[] } = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(doc?.stations)) return false;
    for (const st of doc.stations) {
      if (!st || typeof st !== "object") continue;
      const stRec = st as Record<string, unknown>;
      const nameOk = stationName !== undefined && stRec.name === stationName;
      const num =
        typeof stRec.station === "number"
          ? stRec.station
          : typeof stRec.station === "string"
            ? parseInt(stRec.station, 10)
            : NaN;
      const idOk = stationId !== undefined && stRec.station !== undefined && !isNaN(num) && num === stationId;
      if (!nameOk && !idOk) continue;

      // Published layout: { ip: "127.0.0.1", port: <onlinePort> }
      const ip = typeof stRec.ip === "string" ? stRec.ip : undefined;
      if (ip === "127.0.0.1" && String(stRec.port) === String(onlinePort)) return true;

      // Design-time layout: connection/conType = "127.0.0.1:<onlinePort>"
      const v =
        typeof stRec.connection === "string"
          ? stRec.connection
          : typeof stRec.conType === "string"
            ? stRec.conType
            : undefined;
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
  const protectProjects = opts.protectProjects ?? [];

  for (const ws of workspaces) {
    const inst = instances[ws.name];
    let reason: string;
    if (!inst) {
      reason = "manual (no instance bookkeeping) — kept";
    } else if (isRunning(ws.name)) {
      reason = "running";
    } else if (protectProjects.some((p) => instanceBelongsToProject(inst, p))) {
      reason = "selected project — kept";
    } else {
      const lssPoints = inst.stationLssPath
        ? (() => {
            const conn = readLssConnection(inst.stationLssPath);
            return !("error" in conn) && conn.ip === "127.0.0.1" && conn.port === String(ws.onlinePort);
          })()
        : false;
      const dsPoints =
        inst.stationName !== undefined || inst.stationId !== undefined
          ? stationsJsonFiles.some((f) => stationsJsonPointsAt(f, inst.stationName, inst.stationId, ws.onlinePort))
          : false;
      reason =
        lssPoints || dsPoints ? "referenced (station .lss or DataService stations.json points at it)" : "unreferenced";
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
    const filter = name ? ` | Where-Object { $_.MainWindowTitle -like '*${name}*' }` : "";
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process -Name Lars -ErrorAction SilentlyContinue${filter} | Select-Object -ExpandProperty Id"`,
      { encoding: "utf-8" },
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
  const installDir = dirname(LARS_EXE);
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

/**
 * Online ports owned by currently running LARS instances. Never hand one of these to
 * another workspace — PLC and HMI must stay on distinct ports.
 */
export function runningInstancePorts(
  instances: Record<string, LarsInstanceInfo> | undefined,
  excludeName?: string,
): number[] {
  const out: number[] = [];
  for (const [name, inst] of Object.entries(instances ?? {})) {
    if (name === excludeName) continue;
    if (getLarsPids(name).length === 0) continue;
    const port = inst.effectiveOnlinePort ?? inst.onlinePort;
    if (typeof port === "number" && port > 0) out.push(port);
  }
  return out;
}

/**
 * Resolve which port a LARS instance actually services.
 *
 * LARS builds differ in how they pick the online port:
 *  - config-table behavior: the instance binds the workspace's configured ONLINE port
 *    (verified against the pre-2026-10-15 build: PLC workspaces served 1974, HMI 1964);
 *  - the 01.03.216 build field-tested on 2026-10-15: a single instance binds the
 *    DEFAULT port 1954 regardless of the table, and a second concurrent instance
 *    exposes no online port at all.
 *
 * Probing the candidates — while refusing ports another running instance already owns —
 * yields the right answer for both behaviors without hardcoding either.
 */
export async function resolveEffectiveOnlinePort(
  candidates: number[],
  ownedPorts: Iterable<number>,
  probe: (port: number) => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<number | null> {
  const owned = new Set(ownedPorts);
  const wanted = [...new Set(candidates)].filter((p) => Number.isInteger(p) && p > 0 && !owned.has(p));
  if (wanted.length === 0) return null;

  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    for (const port of wanted) {
      if (owned.has(port)) continue;
      if (await probe(port)) return port;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, intervalMs)));
  }
}

// ─── LARS window screenshot (LASAL Screen local simulation) ───────────────────
//
// LARS renders LASAL SCREEN projects (SCREEN_PRJ_PATH workspaces) into its
// workspace window via GDI4LSE. Capturing that window lets agents visually
// verify screens without hardware.

export function captureLarsWindow(name: string, outPath: string): { ok: boolean; error?: string } {
  const pid = getLarsPids(name)[0];
  if (!pid) {
    return { ok: false, error: `No running LARS instance found for workspace '${name}'.` };
  }

  const psPath = join(SCRATCH, `lars_shot_${Date.now()}.ps1`);
  const escapedOut = outPath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "$sig = 'using System; using System.Runtime.InteropServices;",
    "public class WinCap {",
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "}'",
    "Add-Type -TypeDefinition $sig",
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    "$h = $p.MainWindowHandle",
    "if ($h -eq [IntPtr]::Zero) { throw 'LARS window handle not found (window minimized to tray?)' }",
    "[void][WinCap]::ShowWindow($h, 9)",
    "[void][WinCap]::SetForegroundWindow($h)",
    "Start-Sleep -Milliseconds 400",
    "$r = New-Object -TypeName 'WinCap+RECT'",
    "[void][WinCap]::GetWindowRect($h, [ref]$r)",
    "$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top",
    "if ($w -le 0 -or $ht -le 0) { throw 'LARS window has no drawable size' }",
    "$bmp = New-Object System.Drawing.Bitmap($w, $ht)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)",
    `$bmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose()",
    "exit 0",
  ].join("\n");

  writeFileSync(psPath, `\uFEFF${script}`, "utf-8");
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, { stdio: "pipe", timeout: 30000 });
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Screenshot failed: ${msg}` };
  } finally {
    try {
      unlinkSync(psPath);
    } catch {
      /* ignore */
    }
  }
}

// ─── Station targeting ────────────────────────────────────────────────────────

/**
 * Point a station's .lss TCPIP profile at a local LARS instance (127.0.0.1:<onlinePort>).
 * Returns the previous connection so it can be restored later.
 */
export function pointStationAtLars(
  lssPath: string,
  onlinePort: number,
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
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[0-9]+/, "_");
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
  isRunning: (name: string) => boolean = (name) => getLarsPids(name).length > 0,
  projectDir?: string | null,
): LarsStationMapping[] {
  const runningByName = new Map<string, LarsInstanceInfo>();
  const runningById = new Map<number, LarsInstanceInfo>();
  for (const inst of Object.values(larsInstances)) {
    if (!isRunning(inst.name)) continue;
    // Never map a published stations.json onto another project's LARS workspace.
    if (projectDir && !instanceBelongsToProject(inst, projectDir)) continue;
    if (inst.stationName) runningByName.set(inst.stationName, inst);
    if (inst.stationId !== undefined) runningById.set(inst.stationId, inst);
  }
  if (runningByName.size === 0 && runningById.size === 0) return [];

  const changed: LarsStationMapping[] = [];
  for (const st of stations) {
    const name = typeof st.name === "string" ? st.name : undefined;
    const num =
      typeof st.station === "number" ? st.station : typeof st.station === "string" ? parseInt(st.station, 10) : NaN;
    const inst = (name && runningByName.get(name)) ?? (!isNaN(num) && runningById.get(num));
    if (!inst) continue;

    const targetPort = inst.effectiveOnlinePort ?? inst.onlinePort;
    const to = `127.0.0.1:${targetPort}`;

    // Published runtime layout: { station, ip, conType }
    const ip = typeof st.ip === "string" ? st.ip : undefined;
    if (ip !== undefined) {
      const isHardwareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith("127.");
      if (!isHardwareIp) continue;
      st.ip = "127.0.0.1";
      st.port = targetPort;
      changed.push({ station: name ?? String(num), from: ip, to });
      continue;
    }

    // Design-time layout: { name, connection | conType }
    const field =
      typeof st.connection === "string" ? "connection" : typeof st.conType === "string" ? "conType" : undefined;
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
