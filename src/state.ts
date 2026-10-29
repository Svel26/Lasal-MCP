import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { withFileLockSync } from "./utils/fileLock.js";
import { isPidAlive } from "./utils/pid.js";

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

/** One agent session's project selection, recorded for status/diagnostics. */
export interface AgentSelection {
  project: string;
  /** Epoch ms when the agent selected the project. */
  since: number;
  label?: string;
}

export interface LasalState {
  /** Shared "last used" hint. Agent resolution uses the per-process selection instead. */
  currentProject: string | null;
  /** PID that last wrote `currentProject`. Absent in legacy state files. */
  currentProjectOwnerPid?: number;
  /** Live agent sessions, keyed by MCP server pid. Purely informational. */
  agentProjects?: Record<string, AgentSelection>;
  hmiRuntime?: HmiRuntimeInfo;
  hmiRuntimes?: Record<string, HmiRuntimeInfo>;
  larsInstances?: Record<string, LarsInstanceInfo>;
  larsGc?: Record<string, { since: number }>;
}

const DEFAULT_STATE: LasalState = {
  currentProject: null,
};

// ─── Per-agent project selection ──────────────────────────────────────────────
//
// `currentProject` used to live only in the shared state file. With several MCP
// server processes (one per agent session) that meant whichever agent called
// select_project last silently redirected everybody else's next tool call.
// Selection is therefore process-local: the shared file keeps only a hint.

const ENV_PROJECT = process.env.LASAL_MCP_PROJECT?.trim() || null;
const INHERIT_SHARED = process.env.LASAL_MCP_INHERIT_PROJECT === "1";
const MAX_AGENT_RECORD_MS = 7 * 24 * 60 * 60 * 1000;

let processProject: string | null = normalizeProjectPath(ENV_PROJECT);

function normalizeProjectPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\\/]+$/, "");
}

/**
 * Resolve the project for this process.
 *
 * The shared hint is inherited only when its writer is gone (a previous session)
 * or when the state file predates ownership tracking. While another agent holds
 * the hint, a fresh process starts unselected instead of silently adopting that
 * agent's project — which is exactly how two agents used to cross-wire.
 */
function effectiveProject(state: Pick<LasalState, "currentProject" | "currentProjectOwnerPid">): string | null {
  if (processProject) return processProject;
  if (!state.currentProject) return null;
  if (INHERIT_SHARED) return state.currentProject;
  const owner = state.currentProjectOwnerPid;
  if (owner === undefined || !isPidAlive(owner)) return state.currentProject;
  return null;
}

/**
 * The project this agent process is currently working on: its own selection, or
 * the shared hint when that hint is inheritable (owner gone / legacy state file).
 */
export function getCurrentProject(): string | null {
  if (processProject) return processProject;
  return effectiveProject(readSharedState());
}

/**
 * Point this agent process at a project. Other agents are unaffected; the shared
 * file only receives a "last used" hint (see `setSharedProjectHint`).
 */
export function setCurrentProject(path: string | null): void {
  processProject = normalizeProjectPath(path);
}

// ─── Shared state I/O ────────────────────────────────────────────────────────

function stateLockPath(): string {
  return `${stateFilePath()}.lock`;
}

function readSharedState(): LasalState {
  const stateFile = stateFilePath();
  if (!existsSync(stateFile)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8")) as LasalState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Write through a temp file + rename so a crash or a concurrent reader never sees
 * a half-written JSON document.
 */
function writeSharedStateUnlocked(state: LasalState): void {
  const stateFile = stateFilePath();
  const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  try {
    renameSync(tmp, stateFile);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function pruneAgentProjects(input: LasalState["agentProjects"]): Record<string, AgentSelection> {
  const out: Record<string, AgentSelection> = {};
  for (const [key, selection] of Object.entries(input ?? {})) {
    const pid = Number(key);
    if (!Number.isInteger(pid) || pid <= 0 || !selection?.project) continue;
    if (pid !== process.pid) {
      if (!isPidAlive(pid)) continue;
      if (Date.now() - (selection.since ?? 0) > MAX_AGENT_RECORD_MS) continue;
    }
    out[key] = selection;
  }
  return out;
}

/**
 * Read the state with this agent's project selection applied.
 *
 * Tool handlers keep using `state.currentProject` exactly as before — the
 * isolation lives here instead of spreading through every handler.
 */
export function readState(): LasalState {
  const state = readSharedState();
  state.currentProject = effectiveProject(state);
  state.agentProjects = pruneAgentProjects(state.agentProjects);
  return state;
}

/**
 * Read-modify-write the shared state under a cross-process lock.
 *
 * The mutator sees this agent's project selection (so existing code keeps
 * working), but the selection is never persisted into the shared hint by an
 * unrelated write — otherwise a LARS bookkeeping update would silently steal
 * `currentProject` from the other agents.
 */
export function updateState<T>(mutator: (state: LasalState) => T, opts: { keepProjectHint?: boolean } = {}): T {
  return withFileLockSync(
    stateLockPath(),
    () => {
      const raw = readSharedState();
      const working: LasalState = {
        ...raw,
        currentProject: effectiveProject(raw),
        agentProjects: pruneAgentProjects(raw.agentProjects),
      };
      const result = mutator(working);
      const toWrite: LasalState = { ...working };
      if (!opts.keepProjectHint) {
        toWrite.currentProject = raw.currentProject ?? null;
      }
      writeSharedStateUnlocked(toWrite);
      return result;
    },
    { label: "lasal-state" },
  );
}

/**
 * Whole-state write. Always locked and atomic.
 *
 * Production code uses `updateState` so a long handler cannot clobber records
 * written by another agent in the meantime. This stays for tests and tooling
 * that intentionally replace the whole document.
 */
export function writeState(state: LasalState): void {
  withFileLockSync(stateLockPath(), () => writeSharedStateUnlocked(state), { label: "lasal-state" });
}

/** Record the shared "last used project" hint and this agent's selection. */
export function setSharedProjectHint(project: string | null, meta: { label?: string } = {}): void {
  withFileLockSync(
    stateLockPath(),
    () => {
      const state = readSharedState();
      state.currentProject = normalizeProjectPath(project);
      state.currentProjectOwnerPid = state.currentProject ? process.pid : undefined;
      const agents = pruneAgentProjects(state.agentProjects);
      if (state.currentProject) {
        agents[String(process.pid)] = {
          project: state.currentProject,
          since: Date.now(),
          ...(meta.label ? { label: meta.label } : {}),
        };
      } else {
        delete agents[String(process.pid)];
      }
      state.agentProjects = agents;
      writeSharedStateUnlocked(state);
    },
    { label: "lasal-state" },
  );
}

/** Live agent selections (current process included). Read-only — does not prune on disk. */
export function getActiveAgents(): Array<AgentSelection & { pid: number; isSelf: boolean }> {
  const state = readSharedState();
  const agents = pruneAgentProjects(state.agentProjects);
  return Object.entries(agents)
    .map(([key, selection]) => ({ pid: Number(key), ...selection, isSelf: Number(key) === process.pid }))
    .sort((a, b) => a.since - b.since);
}

// ─── Per-project runtime bookkeeping ─────────────────────────────────────────

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
