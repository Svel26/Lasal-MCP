import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "lasal-state.json");

export interface HmiRuntimeInfo {
  pid: number;
  port: number;
  url: string;
  dataDir: string;
}

export interface LasalState {
  currentProject: string | null;
  hmiRuntime?: HmiRuntimeInfo;
  hmiRuntimes?: Record<string, HmiRuntimeInfo>;
}

const DEFAULT_STATE: LasalState = {
  currentProject: null,
};

export function readState(): LasalState {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(state: LasalState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
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
