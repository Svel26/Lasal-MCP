import { readState } from "../state.js";
import { resolveLcpPath } from "./resolvePaths.js";
import { parseLcp, parseStClass } from "./lasalXml.js";
import { findLsmPath, parseSolution } from "./projectScanner.js";
import { existsSync } from "fs";
import { basename } from "path";

/**
 * Return matching CLASS 2 class names in the active project.
 */
export async function completeClassNames(prefix = ""): Promise<string[]> {
  const state = readState();
  if (!state.currentProject) return [];
  const resolved = resolveLcpPath();
  if ("error" in resolved) return [];
  try {
    const lcp = parseLcp(resolved.path);
    const names: string[] = [];
    const lower = prefix.toLowerCase();
    for (const cf of lcp.classFiles) {
      if (!cf.relativePath.toLowerCase().endsWith(".st")) continue;
      let name: string | null = null;
      if (existsSync(cf.absPath)) {
        try {
          name = parseStClass(cf.absPath).name;
        } catch {}
      }
      if (!name) {
        name = basename(cf.relativePath, ".st");
      }
      if (name && (!lower || name.toLowerCase().startsWith(lower))) {
        names.push(name);
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * Return matching station names discovered from the .lsm solution file.
 */
export async function completeStationNames(prefix = ""): Promise<string[]> {
  const state = readState();
  if (!state.currentProject) return [];
  const lsmPath = findLsmPath(state.currentProject);
  if (!lsmPath) return [];
  try {
    const soln = parseSolution(lsmPath);
    const lower = prefix.toLowerCase();
    return soln.stations
      .map((s) => s.name)
      .filter((n) => !lower || n.toLowerCase().startsWith(lower))
      .sort();
  } catch {
    return [];
  }
}
