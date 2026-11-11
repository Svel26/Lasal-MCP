import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  findLcpFiles,
  findLprFiles,
  findLsmPath,
  findLvpFiles,
  parseSolution,
  type StationInfo,
} from "../../utils/projectScanner.js";

export interface ProjectCapabilities {
  class2: boolean;
  visu: boolean;
  screen: boolean;
  machineManager: boolean;
}

export type RecommendedProfile = "class2" | "visu" | "screen" | "solution";

export interface ProjectShape {
  lsmPath?: string;
  stations: StationInfo[];
  capabilities: ProjectCapabilities;
  recommendedProfile: RecommendedProfile;
}

function rootFiles(root: string, extension: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => name.toLowerCase().endsWith(extension))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

function safeFiles(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Detect which LASAL project types a solution contains. This is advisory: the
 * user can always force a profile. It never loads an engine.
 */
export function detectProjectShape(root: string): ProjectShape {
  const lsmPath = findLsmPath(root) ?? undefined;
  let stations: StationInfo[] = [];
  if (lsmPath) {
    try {
      stations = parseSolution(lsmPath).stations;
    } catch {
      // A malformed .lsm should not prevent the catalog from starting.
    }
  }

  const lcpPaths = stations.flatMap((station) => station.lcpPaths);
  const lvpPaths = stations.flatMap((station) => station.lvpPaths);
  const lprPaths = stations.flatMap((station) => station.lprPaths);

  const class2 =
    lcpPaths.length > 0 || safeFiles(() => findLcpFiles(root)).length > 0 || rootFiles(root, ".lcp").length > 0;
  const visu =
    lvpPaths.length > 0 || safeFiles(() => findLvpFiles(root)).length > 0 || rootFiles(root, ".lvp").length > 0;
  const screen =
    lprPaths.length > 0 || safeFiles(() => findLprFiles(root)).length > 0 || rootFiles(root, ".lpr").length > 0;
  const machineManager = rootFiles(root, ".lutc").length > 0 || existsSync(join(root, "MachineManager"));

  const kinds = [class2, visu, screen].filter(Boolean).length;
  let recommendedProfile: RecommendedProfile;
  if (kinds === 0) recommendedProfile = "solution";
  else if (kinds > 1) recommendedProfile = "solution";
  else if (class2) recommendedProfile = "class2";
  else if (visu) recommendedProfile = "visu";
  else recommendedProfile = "screen";

  return {
    ...(lsmPath ? { lsmPath } : {}),
    stations,
    capabilities: { class2, visu, screen, machineManager },
    recommendedProfile,
  };
}
