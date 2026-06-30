import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  isArray: (name) => name === "File" || name === "SlnClassProject" || name === "SlnVISUDesignerProject",
});

function readLatin1(path: string): string {
  return readFileSync(path, "latin1");
}

export interface StationInfo {
  name: string;
  lssPath: string;
  ip?: string;
  port?: string;
  ssltls?: string;
  lcpPaths: string[];
  lvpPaths: string[];
}

export interface SolutionInfo {
  lsmPath: string;
  stations: StationInfo[];
}

/** Parse an .lsm file and all referenced .lss files to build a solution map. */
export function parseSolution(lsmPath: string): SolutionInfo {
  const lsmDir = dirname(lsmPath);
  const lsmContent = readLatin1(lsmPath);
  const doc = parser.parse(lsmContent);
  const solution = doc.Solution ?? {};
  const stationFiles: Array<{ "@_Path": string }> = solution.SlnStationFiles?.File ?? [];

  const stations: StationInfo[] = [];
  for (const sf of stationFiles) {
    if (!sf["@_Path"]) continue;
    const lssPath = resolve(lsmDir, sf["@_Path"].replace(/\\/g, "/"));
    if (!existsSync(lssPath)) continue;
    const station = parseLss(lssPath);
    stations.push(station);
  }
  return { lsmPath, stations };
}

/** Parse a .lss file to extract connection info and project paths. */
export function parseLss(lssPath: string): StationInfo {
  const lssDir = dirname(lssPath);
  const content = readLatin1(lssPath);
  const doc = parser.parse(content);
  const stn = doc.SlnStation ?? {};
  const tcpip = stn.OnlineConnectionInfo?.TCPIP ?? {};

  const lcpPaths: string[] = [];
  const lvpPaths: string[] = [];

  const projects = stn.SlnProjects ?? {};
  for (const cp of (projects.SlnClassProject ?? []) as any[]) {
    if (cp["@_File"]) {
      const abs = resolve(lssDir, cp["@_File"].replace(/\\/g, "/"));
      if (existsSync(abs)) lcpPaths.push(abs);
    }
  }
  for (const vp of (projects.SlnVISUDesignerProject ?? []) as any[]) {
    if (vp["@_File"]) {
      const abs = resolve(lssDir, vp["@_File"].replace(/\\/g, "/"));
      if (existsSync(abs)) lvpPaths.push(abs);
    }
  }

  return {
    name: stn["@_Name"] ?? basename(lssPath, ".lss"),
    lssPath,
    ip: tcpip["@_IP"],
    port: tcpip["@_PORT"],
    ssltls: tcpip["@_SSLTLS"],
    lcpPaths,
    lvpPaths,
  };
}

/** Locate the .lsm file for a solution directory. */
export function findLsmPath(solutionDir: string): string | null {
  const name = basename(solutionDir);
  const direct = join(solutionDir, `${name}.lsm`);
  if (existsSync(direct)) return direct;
  // Fall back: search for any .lsm in the directory
  try {
    for (const f of readdirSync(solutionDir)) {
      if (f.endsWith(".lsm")) return join(solutionDir, f);
    }
  } catch { /* ignore */ }
  return null;
}

/** Resolve all .lcp files in a solution directory (via .lsm + .lss), or fall back to filesystem scan. */
export function findLcpFiles(solutionDir: string): string[] {
  const lsmPath = findLsmPath(solutionDir);
  if (lsmPath) {
    const solution = parseSolution(lsmPath);
    const paths = solution.stations.flatMap((s) => s.lcpPaths);
    if (paths.length > 0) return paths;
  }
  // Fallback: filesystem search under Stations/
  return findFilesDeep(join(solutionDir, "Stations"), ".lcp");
}

/** Resolve all .lvp files in a solution directory (via .lsm + .lss), or fall back to filesystem scan. */
export function findLvpFiles(solutionDir: string): string[] {
  const lsmPath = findLsmPath(solutionDir);
  if (lsmPath) {
    const solution = parseSolution(lsmPath);
    const paths = solution.stations.flatMap((s) => s.lvpPaths);
    if (paths.length > 0) return paths;
  }
  return findFilesDeep(join(solutionDir, "Stations"), ".lvp");
}

function findFilesDeep(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(ext)) results.push(full);
      } catch { /* skip inaccessible */ }
    }
  }
  walk(dir);
  return results;
}

/** Surgically update the TCPIP IP (and optionally port/ssltls) in a .lss file, byte-preserving everything else. */
export function updateLssConnection(
  lssPath: string,
  updates: { ip?: string; port?: string; ssltls?: string }
): void {
  let content = readLatin1(lssPath);
  const tcpipRe = /(<TCPIP\s[^>]*?>)/s;
  const m = tcpipRe.exec(content);
  if (!m) throw new Error(`No <TCPIP .../> element found in ${lssPath}`);

  let tag = m[1];
  if (updates.ip !== undefined) tag = setAttr(tag, "IP", updates.ip);
  if (updates.port !== undefined) tag = setAttr(tag, "PORT", updates.port);
  if (updates.ssltls !== undefined) tag = setAttr(tag, "SSLTLS", updates.ssltls);

  content = content.slice(0, m.index) + tag + content.slice(m.index + m[1].length);
  writeFileSync(lssPath, content, "latin1");
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\b${name}\\s*=\\s*")[^"]*(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$2`);
  // Attribute not present — insert before the closing >
  return tag.replace(/(\/?>)$/, ` ${name}="${value}"$1`);
}

import { writeFileSync } from "fs";
