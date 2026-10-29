import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  isArray: (name) =>
    name === "File" || name === "SlnClassProject" || name === "SlnVISUDesignerProject" || name === "SlnScreenProject",
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
  lprPaths: string[];
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
  const lprPaths: string[] = [];

  const projects = stn.SlnProjects ?? {};
  const classProjects = (projects.SlnClassProject ?? []) as Array<Record<string, unknown>>;
  for (const cp of classProjects) {
    if (typeof cp["@_File"] === "string") {
      const abs = resolve(lssDir, cp["@_File"].replace(/\\/g, "/"));
      if (existsSync(abs)) lcpPaths.push(abs);
    }
  }
  const visuProjects = (projects.SlnVISUDesignerProject ?? []) as Array<Record<string, unknown>>;
  for (const vp of visuProjects) {
    if (typeof vp["@_File"] === "string") {
      const abs = resolve(lssDir, vp["@_File"].replace(/\\/g, "/"));
      if (existsSync(abs)) lvpPaths.push(abs);
    }
  }
  const screenProjects = (projects.SlnScreenProject ?? []) as Array<Record<string, unknown>>;
  for (const sp of screenProjects) {
    if (typeof sp["@_File"] === "string") {
      const abs = resolve(lssDir, sp["@_File"].replace(/\\/g, "/"));
      if (existsSync(abs)) lprPaths.push(abs);
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
    lprPaths,
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
  } catch {
    /* ignore */
  }
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

/** Resolve all .lpr files (LASAL Screen projects) in a solution directory, or fall back to filesystem scan. */
export function findLprFiles(solutionDir: string): string[] {
  const lsmPath = findLsmPath(solutionDir);
  if (lsmPath) {
    const solution = parseSolution(lsmPath);
    const paths = solution.stations.flatMap((s) => s.lprPaths);
    if (paths.length > 0) return paths;
  }
  return findFilesDeep(join(solutionDir, "Stations"), ".lpr");
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
      } catch {
        /* skip inaccessible */
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Read the VISUDesigner station manager mapping (name -> stationId) from a .lvp's
 * Stations/Stations.json. Returns e.g. { PLC: 10, HMI: 255, Local: 0 }.
 */
export function readVisuStationIds(lvpPath: string): Record<string, number> {
  const result: Record<string, number> = {};
  try {
    const lvpDir = dirname(lvpPath);
    const file = join(lvpDir, "Stations", "Stations.json");
    if (!existsSync(file)) return result;
    const doc = JSON.parse(readFileSync(file, "utf-8"));
    if (!Array.isArray(doc?.stations)) return result;
    for (const st of doc.stations) {
      if (!st || typeof st !== "object") continue;
      const stRec = st as Record<string, unknown>;
      const name = typeof stRec.name === "string" ? stRec.name : undefined;
      const id =
        typeof stRec.stationId === "number"
          ? stRec.stationId
          : typeof stRec.stationId === "string"
            ? parseInt(stRec.stationId, 10)
            : NaN;
      if (name && !isNaN(id)) result[name] = id;
    }
  } catch {}
  return result;
}

/** Name of the connection profile this server adds for local simulation. */
export const LARS_PROFILE_NAME = "LARS";

const TCPIP_TAG_RE = /<TCPIP\s[^>]*?\/>/gs;

function profileNameOf(tag: string): string | undefined {
  return tag.match(/\bConfigName\s*=\s*"([^"]*)"/)?.[1];
}

/** Profile the station currently uses (the <SlnStation OnlineConnection="..."> value). */
export function readLssActiveProfile(lssPath: string): string | undefined {
  if (!existsSync(lssPath)) return undefined;
  try {
    const content = readLatin1(lssPath);
    return content.match(/<SlnStation\s[^>]*?\bOnlineConnection\s*=\s*"([^"]*)"/s)?.[1];
  } catch {
    return undefined;
  }
}

/** The <TCPIP .../> tag of the named profile, if the file has one. */
function findProfileTag(content: string, name: string): string | undefined {
  for (const m of content.matchAll(TCPIP_TAG_RE)) {
    if (profileNameOf(m[0]) === name) return m[0];
  }
  return undefined;
}

/** Read a TCPIP connection from a .lss file, preferring the profile the station is using. */
export function readLssConnection(lssPath: string): { ip: string; port: string } | { error: string } {
  if (!existsSync(lssPath)) return { error: `LSS file not found: ${lssPath}` };
  try {
    const content = readLatin1(lssPath);
    const active = content.match(/<SlnStation\s[^>]*?\bOnlineConnection\s*=\s*"([^"]*)"/s)?.[1];
    // A .lss can hold several profiles (hardware + LARS); the active one is the truth.
    const tag = (active ? findProfileTag(content, active) : undefined) ?? content.match(TCPIP_TAG_RE)?.[0];
    if (!tag) return { error: `No <TCPIP .../> element found in ${lssPath}` };
    const ip = tag.match(/\bIP\s*=\s*"([^"]*)"/)?.[1];
    const port = tag.match(/\bPORT\s*=\s*"([^"]*)"/)?.[1];
    if (ip && port) return { ip, port };
    if (ip) return { ip, port: "1954" };
    return { error: `No IP attribute on the active <TCPIP/> in ${lssPath}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed to parse ${lssPath}: ${msg}` };
  }
}

/**
 * Surgically update the active TCPIP profile's IP (and optionally port/ssltls),
 * byte-preserving everything else.
 */
export function updateLssConnection(lssPath: string, updates: { ip?: string; port?: string; ssltls?: string }): void {
  let content = readLatin1(lssPath);
  const active = content.match(/<SlnStation\s[^>]*?\bOnlineConnection\s*=\s*"([^"]*)"/s)?.[1];
  const existing = active ? findProfileTag(content, active) : undefined;
  const first = content.match(TCPIP_TAG_RE)?.[0];

  if (!existing && !first) {
    // No <TCPIP> element yet (e.g. a Local/simulation station) — insert one
    // right after the <SlnStation ...> opening tag.
    const stationRe = /(<SlnStation\s[^>]*>)/s;
    const sm = stationRe.exec(content);
    if (!sm) throw new Error(`No <SlnStation ...> element found in ${lssPath}`);
    const tag = `<OnlineConnectionInfo>\n\t\t<TCPIP ConfigName="MCP" BUS="3" Password="" IP="${updates.ip ?? "127.0.0.1"}" PORT="${updates.port ?? "1954"}" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="${updates.ssltls ?? "0"}" Favorite="0"/>\n\t</OnlineConnectionInfo>`;
    content = content.slice(0, sm.index! + sm[1]!.length) + "\n\t" + tag + content.slice(sm.index! + sm[1]!.length);
    writeFileSync(lssPath, content, "latin1");
    return;
  }

  let tag = existing ?? first!;
  if (updates.ip !== undefined) tag = setAttr(tag, "IP", updates.ip);
  if (updates.port !== undefined) tag = setAttr(tag, "PORT", updates.port);
  if (updates.ssltls !== undefined) tag = setAttr(tag, "SSLTLS", updates.ssltls);
  writeFileSync(lssPath, content.replace(existing ?? first!, tag), "latin1");
}

/** Set <SlnStation OnlineConnection="...">, adding the attribute when absent. */
export function setLssActiveProfile(lssPath: string, profileName: string): boolean {
  let content = readLatin1(lssPath);
  const attrRe = /(<SlnStation\s[^>]*?\bOnlineConnection\s*=\s*")[^"]*(")/s;
  if (attrRe.test(content)) {
    content = content.replace(attrRe, `$1${profileName}$2`);
  } else {
    const stationRe = /(<SlnStation\b[^>]*?)(\s*>)/s;
    const sm = stationRe.exec(content);
    if (!sm) return false;
    content = content.replace(stationRe, `$1 OnlineConnection="${profileName}"$2`);
  }
  writeFileSync(lssPath, content, "latin1");
  return true;
}

export interface LssProfileResult {
  /** Profile the station now uses. */
  connection: string;
  /** Profile it used before the change. */
  previousConnection: string;
  /** True when the LARS profile had to be created. */
  added: boolean;
}

/**
 * Point a station at a local LARS instance by adding (or updating) a dedicated
 * profile and switching the station to it.
 *
 * Overwriting the existing profile's IP was destructive: the machine address only
 * survived in saved state and the profile got renamed, so a restore could put back
 * a wrong address. Keeping both profiles in the .lss means switching back is a
 * single attribute and no address is ever lost.
 */
export function pointStationAtProfile(
  lssPath: string,
  port: number | string,
  profileName: string = LARS_PROFILE_NAME,
): LssProfileResult | { error: string } {
  if (!existsSync(lssPath)) return { error: `LSS file not found: ${lssPath}` };
  let content = readLatin1(lssPath);

  const previousConnection =
    content.match(/<SlnStation\s[^>]*?\bOnlineConnection\s*=\s*"([^"]*)"/s)?.[1] ?? profileName;

  const existing = findProfileTag(content, profileName);
  let added = false;
  if (existing) {
    let tag = setAttr(existing, "IP", "127.0.0.1");
    tag = setAttr(tag, "PORT", String(port));
    content = content.replace(existing, tag);
  } else {
    const tag = `<TCPIP ConfigName="${profileName}" BUS="3" Password="" IP="127.0.0.1" PORT="${port}" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="0" Favorite="0"/>`;
    const tags = [...content.matchAll(TCPIP_TAG_RE)];
    if (tags.length > 0) {
      const last = tags[tags.length - 1]!;
      const at = last.index! + last[0].length;
      content = `${content.slice(0, at)}\n\t\t${tag}${content.slice(at)}`;
    } else {
      const stationRe = /(<SlnStation\s[^>]*>)/s;
      const sm = stationRe.exec(content);
      if (!sm) return { error: `No <SlnStation ...> element found in ${lssPath}` };
      const at = sm.index! + sm[1]!.length;
      content = `${content.slice(0, at)}\n\t<OnlineConnectionInfo>\n\t\t${tag}\n\t</OnlineConnectionInfo>${content.slice(at)}`;
    }
    added = true;
  }

  writeFileSync(lssPath, content, "latin1");
  if (!setLssActiveProfile(lssPath, profileName)) {
    return { error: `Could not set OnlineConnection on ${lssPath}` };
  }
  return { connection: profileName, previousConnection, added };
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\b${name}\\s*=\\s*")[^"]*(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$2`);
  // Attribute not present — insert before the closing >
  return tag.replace(/(\/?>)$/, ` ${name}="${value}"$1`);
}

import { writeFileSync } from "fs";
