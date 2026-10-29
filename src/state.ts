import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DEFAULT_STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "lasal-state.json");

/**
 * Effective state file path. `LASAL_MCP_STATE_FILE` lets tests (and multi-instance setups)
 * use an isolated file — without it, test runs overwrote the live MCP state.
 */
function stateFilePath(): string {
  return process.env.LASAL_MCP_STATE_FILE || DEFAULT_STATE_FILE;
}

export interface HmiRuntimeInfo {
  pid: number;
  port: number;
  url: string;
  dataDir: string;
}

export interface LarsInstanceInfo {
  name: string;
  onlinePort: number;
  /** Port the running instance actually services (probed at start; may differ from the configured onlinePort). */
  effectiveOnlinePort?: number;
  stationName?: string;
  stationId?: number;
  stationLssPath?: string;
  lcpPath?: string;
  projectDir?: string;
  role?: "plc" | "hmi" | "unknown";
  originalIp?: string;
  originalPort?: string;
  /**
   * Connection profile the station used before being pointed at LARS. Switching back
   * to it is the restore path now that the LARS target is a separate profile.
   */
  originalConnection?: string;
  originalTargetTag?: string;
  /**
   * Set when the station .lss was pointed at LARS. Distinguishes "never overridden"
   * from "the original target happened to be empty", which `!originalIp` cannot.
   */
  stationTargetOverridden?: boolean;
  /** Host files copied into the workspace data root before each start. */
  seedFiles?: string[];
  pid?: number;
}

export interface LasalState {
  currentProject: string | null;
  hmiRuntime?: HmiRuntimeInfo;
  hmiRuntimes?: Record<string, HmiRuntimeInfo>;
  larsInstances?: Record<string, LarsInstanceInfo>;
  larsGc?: Record<string, { since: number }>;
}

const DEFAULT_STATE: LasalState = {
  currentProject: null,
};

export function readState(): LasalState {
  const stateFile = stateFilePath();
  if (!existsSync(stateFile)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(state: LasalState): void {
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf-8");
}

export function getHmiForProject(state: LasalState, projectDir?: string): HmiRuntimeInfo | undefined {
  const key = projectDir ?? state.currentProject;
  if (!key) return state.hmiRuntime;
  return state.hmiRuntimes?.[key] ?? state.hmiRuntime;
}

export function setHmiForProject(state: LasalState, info: HmiRuntimeInfo, projectDir?: string): void {
  const key = projectDir ?? state.currentProject;
  state.hmiRuntime = info;
  if (key) {
    if (!state.hmiRuntimes) state.hmiRuntimes = {};
    state.hmiRuntimes[key] = info;
  }
}

export function clearHmiForProject(state: LasalState, projectDir?: string): void {
  const key = projectDir ?? state.currentProject;
  state.hmiRuntime = undefined;
  if (key && state.hmiRuntimes) {
    delete state.hmiRuntimes[key];
  }
}

export function getLarsInstance(state: LasalState, name: string): LarsInstanceInfo | undefined {
  return state.larsInstances?.[name];
}

export function setLarsInstance(state: LasalState, info: LarsInstanceInfo): void {
  if (!state.larsInstances) state.larsInstances = {};
  state.larsInstances[info.name] = info;
}

/**
 * Merge an instance record instead of replacing it.
 *
 * Callers that only know configuration (name, ports, station paths) must not erase
 * runtime bookkeeping they do not set — pid, effectiveOnlinePort, originalIp/Port,
 * originalTargetTag, stationTargetOverridden. Replacing the record made the
 * "never hand a port another running instance owns" guard trust a stale port and
 * claim the wrong instance's online port.
 *
 * Undefined fields in `info` are ignored so a station without a .lss cannot wipe a
 * previously known path.
 */
export function mergeLarsInstance(state: LasalState, info: LarsInstanceInfo): LarsInstanceInfo {
  const prev = getLarsInstance(state, info.name);
  const next = { ...(prev ?? {}) } as LarsInstanceInfo;
  for (const [key, value] of Object.entries(info)) {
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  setLarsInstance(state, next);
  return next;
}

export function removeLarsInstance(state: LasalState, name: string): void {
  if (state.larsInstances) {
    delete state.larsInstances[name];
    if (Object.keys(state.larsInstances).length === 0) state.larsInstances = undefined;
  }
}
