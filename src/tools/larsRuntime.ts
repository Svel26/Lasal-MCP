import { z } from "zod";
import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import {
  LARS_EXE,
  DEFAULT_ONLINE_PORT,
  larsConfigPath,
  readLarsWorkspaces,
  upsertLarsWorkspace,
  removeLarsWorkspace,
  startLars,
  killLars,
  getLarsPids,
  isLarsHealthy,
  pointStationAtLars,
  safeWorkspaceName,
  gcLarsWorkspaces,
  findLarsInstancesForStation,
  captureLarsWindow,
  switchProjectTargetToPC,
  runningInstancePorts,
  resolveEffectiveOnlinePort,
  type LarsWorkspace,
} from "../utils/lars.js";
import {
  readState,
  writeState,
  getLarsInstance,
  setLarsInstance,
  removeLarsInstance,
  type LarsInstanceInfo,
  type LasalState,
} from "../state.js";
import { HMI_DIR, LARS_GC_MIN_AGE_H, LARS_GC_STATIONS_DIRS, TIMEOUTS } from "../utils/config.js";
import { findLsmPath, parseSolution, readVisuStationIds } from "../utils/projectScanner.js";
import { respond, fail } from "../utils/respond.js";
import { runBatchOps } from "../utils/batchScript.js";
import { batchToStepResult } from "../core/response.js";
import { SCRATCH } from "../utils/engine.js";
import { ensureScratch } from "../core/scratch.js";
import { readFileSync } from "fs";

export const larsRuntimeSchema = {
  action: z
    .enum([
      "list",
      "setup",
      "start",
      "stop",
      "remove",
      "set_station_target",
      "restore",
      "target_pc",
      "gc",
      "screenshot",
      "simulate",
    ])
    .describe(
      "'list' shows all configured LARS workspaces and their state (auto-cleans stale ones, but never the selected project's). " +
        "'setup' creates/updates LARS workspaces for the selected project's stations (or one station/lcp), wiring both the CLASS 2 project and the LASAL SCREEN (.lpr) project so LARS renders the screen locally. " +
        "'start' launches a LARS instance (auto-creates the workspace first if the station is known but unconfigured); reports the effective online port it probed (LARS builds differ in which port they serve). 'stop' terminates it, 'remove' deletes its workspace config. " +
        "'gc' runs lazy garbage collection: deletes auto-created workspaces that are not running and no longer referenced by any station .lss or published DataService stations.json, while always keeping workspaces of the selected project. " +
        "'set_station_target' points a station's .lss at the online port its LARS instance actually services (probed; never a port another running instance owns); 'restore' reverts to the saved real target. " +
        "'target_pc' switches an ARM-compiled .lcp to the PC (x86) compile target LARS requires (restore via 'restore'). " +
        "'simulate' runs the full no-hardware loop in one call: ensure workspace (auto-creates), switch ARM targets to PC, compile, start the local LARS instance (probing its effective online port), then download to it. 'screenshot' captures the LARS window of a running workspace (returns the PNG) — use it to visually verify LASAL SCREEN projects running locally.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "LARS workspace name (e.g. 'VisuPalletizer_PLC'). Required for start/stop/remove/set_station_target/restore when station is omitted.",
    ),
  station: z
    .string()
    .optional()
    .describe(
      "Station name from the selected project's solution (e.g. 'PLC', 'HMI', 'Local'). Resolution is scoped to the selected project; " +
        "a station that only exists in another project's workspace is refused, and multiple matches report an ambiguity error and list the candidates. " +
        "Pass name= to disambiguate. Mutually exclusive with name.",
    ),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to a .lcp to create a workspace for (setup only, when no station name is usable)."),
  project_dir: z
    .string()
    .optional()
    .describe(
      "Solution directory to auto-detect stations from and to scope station resolution (setup/list/start/stop/set_station_target/restore/target_pc/simulate. Defaults to the selected project.",
    ),
  skip_compile: z
    .boolean()
    .optional()
    .default(false)
    .describe("With action 'simulate': skip the CLASS 2 compile step (reuse the existing build). Default false."),
  skip_download: z
    .boolean()
    .optional()
    .default(false)
    .describe("With action 'simulate': skip the download step (only compile + start). Default false."),
  compile_mode: z
    .enum(["RebuildAll", "BuildChanges"])
    .optional()
    .default("RebuildAll")
    .describe("With action 'simulate': CLASS 2 compile mode. Default RebuildAll (safest)."),
  dry_run: z
    .boolean()
    .optional()
    .describe("With action 'gc': report what would be removed without deleting anything. Default false."),
  min_age_h: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "With action 'gc': only delete workspaces unreferenced for at least this many hours (overrides LASAL_MCP_LARS_GC_MIN_AGE_H; 0 = immediately.",
    ),
};

type LarsAction =
  | "list"
  | "setup"
  | "start"
  | "stop"
  | "remove"
  | "set_station_target"
  | "restore"
  | "target_pc"
  | "gc"
  | "screenshot"
  | "simulate";

function detectRole(lcpPath: string): "plc" | "hmi" | "unknown" {
  try {
    const lcpDir = dirname(lcpPath);
    const classDir = join(lcpDir, "Class");
    if (existsSync(classDir)) {
      const entries = readdirSync(classDir);
      if (entries.some((e) => /^_Screen$/i.test(e) || /^_Lse$/i.test(e))) return "hmi";
    }
    if (/hmi|visu/i.test(lcpPath)) return "hmi";
  } catch {}
  return "unknown";
}

function detectStationRole(station: { name: string; lvpPaths: string[] }): "plc" | "hmi" | "unknown" {
  // The station name + presence of a web visu (LVD) project is the reliable
  // discriminator: machine CPUs and panel CPUs both use LSE screen classes.
  if (/hmi|panel|visu|screen/i.test(station.name)) return "hmi";
  if (station.lvpPaths.length > 0) return "hmi";
  if (/plc|machine|mach|local/i.test(station.name)) return "plc";
  return "unknown";
}

interface DetectedStation {
  stationName: string;
  lssPath: string;
  lcpPath: string;
  lvpPath?: string;
  lprPath?: string;
  role: "plc" | "hmi" | "unknown";
}

/** Read the VISU stationId map (station name -> id) for a project's first HMI station. */
function resolveVisuStationIds(projectDir: string): Record<string, number> {
  for (const stn of detectStations(projectDir)) {
    if (stn.role === "hmi" && stn.lvpPath) {
      const ids = readVisuStationIds(stn.lvpPath);
      if (Object.keys(ids).length > 0) return ids;
    }
  }
  return {};
}

function detectStations(projectDir: string): DetectedStation[] {
  const lsmPath = findLsmPath(projectDir);
  if (!lsmPath) return [];
  try {
    const solution = parseSolution(lsmPath);
    const result: DetectedStation[] = [];
    for (const stn of solution.stations) {
      const lcp = stn.lcpPaths[0];
      if (!lcp) continue;
      result.push({
        stationName: stn.name,
        lssPath: stn.lssPath,
        lcpPath: lcp,
        lvpPath: stn.lvpPaths[0],
        lprPath: stn.lprPaths[0],
        role: detectStationRole(stn),
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function workspaceSummary(ws: LarsWorkspace, instances: Record<string, LarsInstanceInfo> | undefined) {
  const inst = instances?.[ws.name];
  const pids = getLarsPids(ws.name);
  const running = pids.length > 0;
  const effectivePort = inst?.effectiveOnlinePort;
  let healthy = false;
  if (running) {
    const port = effectivePort ?? ws.onlinePort;
    healthy = await isLarsHealthy(port);
    // Instances started before effective-port probing existed may serve the default port.
    if (!healthy && effectivePort === undefined && port !== DEFAULT_ONLINE_PORT) {
      healthy = await isLarsHealthy(DEFAULT_ONLINE_PORT);
    }
  }
  return {
    name: ws.name,
    onlinePort: ws.onlinePort,
    effectiveOnlinePort: effectivePort ?? null,
    comlinkServerPort: ws.comlinkServerPort,
    comlinkBasePort: ws.comlinkBasePort,
    alarmPort: ws.alarmPort,
    classProjectPath: ws.classProjectPath ?? null,
    screenProjectPath: ws.screenProjectPath ?? null,
    running,
    pid: pids[0] ?? inst?.pid ?? null,
    healthy,
    stationName: inst?.stationName ?? null,
    lcpPath: inst?.lcpPath ?? null,
    lssPath: inst?.stationLssPath ?? null,
    role: inst?.role ?? null,
    targetedAtLars: inst?.originalIp ? true : false,
  };
}

/**
 * Build a helpful error message when station-based workspace lookup does not yield
 * exactly one candidate. Distinguishes ambiguity inside the selected project from
 * matches that only exist in other projects (the case that must never auto-resolve).
 */
function stationLookupError(
  station: string,
  projectDir: string | null | undefined,
  lookup: { matches: LarsInstanceInfo[]; foreign: LarsInstanceInfo[] },
): string {
  if (lookup.matches.length > 1) {
    return (
      `Station '${station}' is ambiguous — ${lookup.matches.length} LARS workspaces match in the selected project: ` +
      `${lookup.matches.map((i) => i.name).join(", ")}. Pass name= explicitly.`
    );
  }
  if (lookup.foreign.length > 0) {
    const others = lookup.foreign.map((i) => `${i.name} (${i.projectDir ?? "unknown project"})`).join("; ");
    return (
      `No LARS workspace for station '${station}' in the selected project` +
      `${projectDir ? ` (${projectDir})` : ""}. It exists in other projects: ${others}. ` +
      "Select that project first or pass name= explicitly."
    );
  }
  return `No LARS instance for station '${station}'. Use action 'setup' first.`;
}

function requireWorkspace(
  args: { name?: string; station?: string; project_dir?: string },
  state: LasalState,
): {
  workspace?: LarsWorkspace;
  instance?: LarsInstanceInfo;
  error?: string;
} {
  const workspaces = readLarsWorkspaces();
  const instances = state.larsInstances ?? {};

  if (args.name) {
    const workspace = workspaces.find((w) => w.name === args.name);
    if (!workspace) return { error: `No LARS workspace named '${args.name}' found. Use action 'setup' first.` };
    return { workspace, instance: instances[args.name] };
  }

  if (args.station) {
    const projectDir = args.project_dir ?? state.currentProject;
    const lookup = findLarsInstancesForStation(instances, args.station, projectDir);
    if (lookup.matches.length !== 1) {
      return { error: stationLookupError(args.station, projectDir, lookup) };
    }
    const inst = lookup.matches[0]!;
    const workspace = workspaces.find((w) => w.name === inst.name);
    if (!workspace) {
      return {
        error: `Workspace '${inst.name}' for station '${args.station}' is no longer configured — run lars_runtime setup again.`,
      };
    }
    return { workspace, instance: inst };
  }

  return { error: "Provide either 'name' (workspace name) or 'station' (station name)." };
}

function runAutoGc(state: LasalState, projectDir?: string | null, dryRun: boolean = false) {
  const result = gcLarsWorkspaces({
    dryRun,
    minAgeH: LARS_GC_MIN_AGE_H,
    dataDirs: [HMI_DIR, ...LARS_GC_STATIONS_DIRS],
    larsGc: state.larsGc,
    instances: state.larsInstances,
    protectProjects: projectDir ? [projectDir] : [],
  });
  if (!dryRun) {
    state.larsGc = result.larsGc;
    writeState(state);
  }
  return result;
}

/**
 * 'start' auto-creates the workspace whenthe the station is known but not yet configured:
 * eitherthe instance bookkeeping (state) still knows its .lcp, or the station can be
 * detected from the solution. Ports stay stable as long as the workspace exists; a recreated
 * workspace may get a new port block, which is fine since nothing points at it yet.
 */
function ensureWorkspaceForStart(
  args: { name?: string; station?: string; project_dir?: string },
  state: LasalState,
): { workspace?: LarsWorkspace; instance?: LarsInstanceInfo; autoCreated?: boolean; error?: string } {
  const workspaces = readLarsWorkspaces();

  if (args.name) {
    const existing = workspaces.find((w) => w.name === args.name);
    if (existing) return { workspace: existing, instance: state.larsInstances?.[args.name] };
    const inst = state.larsInstances?.[args.name];
    if (inst) {
      const { workspace } = upsertLarsWorkspace(args.name, {
        ...(inst.lcpPath ? { classProjectPath: inst.lcpPath } : {}),
      });
      return { workspace, instance: inst, autoCreated: true };
    }
    return {
      error: `No LARS workspace named '${args.name}' found and no instance bookkeeping exists — run lars_runtime setup first.`,
    };
  }

  if (args.station) {
    const projectDir = args.project_dir ?? state.currentProject;
    const lookup = findLarsInstancesForStation(state.larsInstances, args.station, projectDir);
    if (lookup.matches.length > 1) {
      return { error: stationLookupError(args.station, projectDir, lookup) };
    }
    const inst = lookup.matches[0];
    if (inst) {
      const existing = workspaces.find((w) => w.name === inst.name);
      if (existing) return { workspace: existing, instance: inst };
      const { workspace } = upsertLarsWorkspace(inst.name, {
        ...(inst.lcpPath ? { classProjectPath: inst.lcpPath } : {}),
      });
      return { workspace, instance: inst, autoCreated: true };
    }

    // No bookkeeping for this project — try to detect the station from the solution and set it up now

    if (projectDir) {
      const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "project";
      const stations = detectStations(projectDir);
      const visuStationIds = resolveVisuStationIds(projectDir);
      const station = stations.find((s) => s.stationName === args.station);
      if (station) {
        const name = safeWorkspaceName(projectName, station.stationName);
        const { workspace } = upsertLarsWorkspace(name, { classProjectPath: station.lcpPath });
        const info: LarsInstanceInfo = {
          name: workspace.name,
          onlinePort: workspace.onlinePort,
          stationName: station.stationName,
          stationId: visuStationIds?.[station.stationName],
          stationLssPath: station.lssPath,
          lcpPath: station.lcpPath,
          projectDir,
          role: station.role,
        };
        setLarsInstance(state, info);
        writeState(state);
        return { workspace, instance: info, autoCreated: true };
      }
    }
    return { error: stationLookupError(args.station, projectDir, lookup) };
  }

  return { error: "Provide either 'name' (workspace name) or 'station' (station name." };
}

export async function larsRuntimeHandler(args: {
  action: LarsAction;
  name?: string;
  station?: string;
  lcp_path?: string;
  project_dir?: string;
  dry_run?: boolean;
  min_age_h?: number;
  skip_compile?: boolean;
  skip_download?: boolean;
  compile_mode?: "RebuildAll" | "BuildChanges";
}) {
  const state = readState();
  const action = args.action;

  if (action === "list") {
    // Lazy cleanup first: stale auto-created workspaces (not running, nothing points at them) are dropped automatically.
    // Workspaces of the selected project are always protected from auto-collection.

    const projectDir = args.project_dir ?? state.currentProject;
    const gcResult = runAutoGc(state, projectDir);
    const workspaces = readLarsWorkspaces();
    const projectName = projectDir ? (projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "project") : null;
    const detected = projectDir ? detectStations(projectDir) : [];

    // Show detected-but-not-configured stations so the agent knows what to set up
    const unconfigured = detected
      .filter(
        (d) =>
          projectName === null || !workspaces.some((w) => w.name === safeWorkspaceName(projectName, d.stationName)),
      )
      .map((d) => ({ stationName: d.stationName, lcpPath: d.lcpPath, role: d.role }));

    return respond({
      ok: true,
      larsExe: LARS_EXE,
      exists: existsSync(LARS_EXE),
      configPath: larsConfigPath(),
      workspaces: await Promise.all(workspaces.map((w) => workspaceSummary(w, state.larsInstances))),
      gc: {
        checked: gcResult.kept.length + gcResult.removed.length + gcResult.candidates.length,
        removed: gcResult.removed,
        candidates: gcResult.candidates,
      },
      ...(unconfigured.length ? { unconfiguredStations: unconfigured } : {}),
      hint: "Call lars_runtime setup to create workspaces for all stations, then start + set_station_target per station. Unreferenced auto-created workspaces are cleaned up automatically.",
    });
  }
  if (action === "setup") {
    const projectDir = args.project_dir ?? state.currentProject;

    if (!projectDir) {
      return fail("No project selected.", ["Call select_project first or pass project_dir."]);
    }

    // Drop stale auto-created workspaces first, so port allocation sees the current set.

    runAutoGc(state, projectDir);

    const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "project";
    const stations = detectStations(projectDir);
    const created: Array<Record<string, unknown>> = [];

    // Map station names to their VISU stationIds (e.g. PLC -> 10, HMI -> 255) so the
    // published DataService stations.json (numeric `station` field) can be pointed at
    // the right LARS instance. Read from the first HMI/lvp station's Stations.json.
    const visuStationIds = resolveVisuStationIds(projectDir);

    if (args.lcp_path) {
      // Single lcp: build a workspace named after the project + lcp base
      const lcpBase =
        args.lcp_path
          .split(/[\\/]/)
          .filter(Boolean)
          .pop()
          ?.replace(/\.lcp$/i, "") ?? "project";
      const name = safeWorkspaceName(projectName, lcpBase);
      const role = detectRole(args.lcp_path);
      const { workspace } = upsertLarsWorkspace(name, {
        classProjectPath: args.lcp_path,
      });
      setLarsInstance(state, {
        name: workspace.name,
        onlinePort: workspace.onlinePort,
        lcpPath: args.lcp_path,
        projectDir,
        role,
      });
      writeState(state);
      created.push({ name: workspace.name, onlinePort: workspace.onlinePort, lcpPath: args.lcp_path, role });
    } else if (args.station) {
      const station = stations.find((s) => s.stationName === args.station);
      if (!station)
        return fail(`Station '${args.station}' not found in ${projectDir}.`, [
          "Check lasal_status for the station list.",
        ]);
      const name = safeWorkspaceName(projectName, station.stationName);
      const { workspace } = upsertLarsWorkspace(name, {
        classProjectPath: station.lcpPath,
        ...(station.lprPath ? { screenProjectPath: station.lprPath } : {}),
      });
      setLarsInstance(state, {
        name: workspace.name,
        onlinePort: workspace.onlinePort,
        stationName: station.stationName,
        stationId: visuStationIds[station.stationName],
        stationLssPath: station.lssPath,
        lcpPath: station.lcpPath,
        projectDir,
        role: station.role,
      });
      writeState(state);
      created.push({
        name: workspace.name,
        onlinePort: workspace.onlinePort,
        stationName: station.stationName,
        lcpPath: station.lcpPath,
        screenProjectPath: workspace.screenProjectPath ?? null,
        role: station.role,
      });
    } else {
      for (const station of stations) {
        const name = safeWorkspaceName(projectName, station.stationName);
        const { workspace } = upsertLarsWorkspace(name, {
          classProjectPath: station.lcpPath,
          ...(station.lprPath ? { screenProjectPath: station.lprPath } : {}),
        });
        setLarsInstance(state, {
          name: workspace.name,
          onlinePort: workspace.onlinePort,
          stationName: station.stationName,
          stationId: visuStationIds[station.stationName],
          stationLssPath: station.lssPath,
          lcpPath: station.lcpPath,
          projectDir,
          role: station.role,
        });
        created.push({
          name: workspace.name,
          onlinePort: workspace.onlinePort,
          stationName: station.stationName,
          lcpPath: station.lcpPath,
          screenProjectPath: workspace.screenProjectPath ?? null,
          role: station.role,
        });
      }
      writeState(state);
    }

    if (created.length === 0) {
      return fail("No stations with .lcp projects found.", [
        "Ensure the solution has a .lsm file with station .lss files.",
      ]);
    }

    return respond({
      ok: true,
      created,
      hint: "Next: lars_runtime start for each workspace, then set_station_target to point the station's .lss at LARS.",
    });
  }

  if (action === "gc") {
    const dryRun = args.dry_run ?? false;
    const gcResult = gcLarsWorkspaces({
      dryRun,
      minAgeH: args.min_age_h ?? LARS_GC_MIN_AGE_H,
      dataDirs: [HMI_DIR, ...LARS_GC_STATIONS_DIRS],
      larsGc: state.larsGc,
      instances: state.larsInstances,
      protectProjects: [state.currentProject].filter((p): p is string => !!p),
    });
    if (!dryRun) {
      state.larsGc = gcResult.larsGc;
      writeState(state);
    }
    return respond({
      ok: true,
      dryRun,
      gc: {
        checked: gcResult.kept.length + gcResult.removed.length + gcResult.candidates.length,
        removed: gcResult.removed,
        kept: gcResult.kept,
        candidates: gcResult.candidates,
      },
      hint: dryRun
        ? "Dry run — nothing deleted. Remove dry_run:false to actually clean up."
        : "Unreferenced auto-created workspaces were removed. 'start' will auto-recreate one on demand if a station needs it again.",
    });
  }

  if (action === "simulate") {
    const req = ensureWorkspaceForStart(args, state);
    if (req.error) return fail(req.error, []);
    const workspace = req.workspace!;
    const inst = req.instance ?? getLarsInstance(state, workspace.name);

    const lcpPath = inst?.lcpPath ?? args.lcp_path;
    if (!lcpPath || !existsSync(lcpPath)) {
      return fail(`No CLASS 2 project linked to workspace '${workspace.name}'.`, [
        "Run lars_runtime setup for the station first, or pass lcp_path.",
      ]);
    }

    const steps: Record<string, unknown> = {};
    const hints: string[] = [];

    // LARS is an x86 runtime — ARM images are rejected.
    const raw = readFileSync(lcpPath, "latin1");
    const targetTag = raw.match(/<Target\s[^>]*?>/);
    if (targetTag && /\bProcessor\s*=\s*"ARM"/.test(targetTag[0])) {
      const switched = switchProjectTargetToPC(lcpPath);
      if ("error" in switched) return fail(switched.error, []);
      if (inst && inst.originalTargetTag === undefined) {
        inst.originalTargetTag = switched.previousTag;
        setLarsInstance(state, inst);
        writeState(state);
      }
      steps.target_pc = { ok: true, targetBefore: switched.previousTag, targetNow: switched.newTag };
      hints.push("Compile target switched ARM → PC for LARS. Use lars_runtime restore to revert it.");
    }

    if (!args.skip_compile) {
      const br = await runBatchOps(
        lcpPath,
        [{ type: "compile", optionName: args.compile_mode ?? "RebuildAll" }],
        TIMEOUTS.compile,
      );
      steps.compile = batchToStepResult(br);
      if (!br.ok) {
        return respond({
          ok: false,
          workspace: workspace.name,
          steps,
          error: "Compile failed.",
          hints: [...hints, ...(br.hints ?? [])],
        });
      }
    }

    // LARS must be up (and answering) before the download — the CLASS 2 online
    // connection needs a live listener, so start + probe come before it.
    const result = await startLars(workspace);
    if (result.error) return fail(result.error, ["Check LASAL_LARS_EXE / the LARS installation."]);

    const owned = runningInstancePorts(state.larsInstances, workspace.name);
    const effectivePort = await resolveEffectiveOnlinePort([workspace.onlinePort, DEFAULT_ONLINE_PORT], owned, (p) =>
      isLarsHealthy(p),
    );
    const healthy = effectivePort !== null;

    if (inst) {
      inst.pid = result.pid ?? inst.pid;
      inst.onlinePort = workspace.onlinePort;
      inst.effectiveOnlinePort = effectivePort ?? undefined;
      setLarsInstance(state, inst);
      writeState(state);
    }
    steps.start = {
      ok: result.running,
      pid: result.pid,
      healthy,
      onlinePort: effectivePort ?? workspace.onlinePort,
      configuredOnlinePort: workspace.onlinePort,
    };

    if (!args.skip_download) {
      if (!healthy) {
        return respond({
          ok: false,
          workspace: workspace.name,
          steps,
          error:
            `LARS is running but no online port answered among [${workspace.onlinePort}, ${DEFAULT_ONLINE_PORT}]` +
            (owned.length ? ` (${owned.join(", ")} already owned by another running instance)` : "") +
            " — cannot download to it.",
          hints,
        });
      }
      const connection = `TCPIP:127.0.0.1:${effectivePort ?? workspace.onlinePort}`;
      const br = await runBatchOps(
        lcpPath,
        [{ type: "download", connection, addLoaderAnyway: true }],
        TIMEOUTS.download,
      );
      steps.download = batchToStepResult(br);
      if (!br.ok) {
        return respond({
          ok: false,
          workspace: workspace.name,
          steps,
          error: "Download to the LARS instance failed.",
          hints: [...hints, ...(br.hints ?? [])],
        });
      }
    }

    hints.push(
      "Verify visuals with lars_runtime screenshot. Run lars_runtime set_station_target once so control_plc/plc_values also target this instance.",
    );
    return respond({
      ok: healthy,
      workspace: workspace.name,
      onlinePort: effectivePort ?? workspace.onlinePort,
      ...(workspace.screenProjectPath ? { screenProjectPath: workspace.screenProjectPath } : {}),
      steps,
      hints,
    });
  }

  if (
    action === "start" ||
    action === "stop" ||
    action === "remove" ||
    action === "set_station_target" ||
    action === "restore" ||
    action === "target_pc"
  ) {
    // 'start' auto-creates the workspace when the station is known but unconfigured;
    // all other actions require an existing configured workspace.

    const req = action === "start" ? ensureWorkspaceForStart(args, state) : requireWorkspace(args, state);
    if (req.error) return fail(req.error, []);
    const workspace = req.workspace!;
    const autoCreated = (req as { autoCreated?: boolean }).autoCreated ?? false;

    if (action === "stop") {
      killLars(workspace.name);
      const inst = req.instance;
      if (inst) {
        inst.pid = undefined;
        setLarsInstance(state, inst);
        writeState(state);
      }
      return respond({ ok: true, message: `LARS workspace '${workspace.name}' stopped.` });
    }

    if (action === "remove") {
      killLars(workspace.name);
      removeLarsWorkspace(workspace.name);
      removeLarsInstance(state, workspace.name);
      writeState(state);
      return respond({ ok: true, message: `LARS workspace '${workspace.name}' removed (ports freed).` });
    }

    if (action === "start") {
      const result = await startLars(workspace);
      if (result.error) return fail(result.error, ["Check LASAL_LARS_EXE / the LARS installation."]);

      // Find the port this instance actually services (LARS builds differ — see
      // resolveEffectiveOnlinePort in utils/lars.ts). Never take a port another
      // running instance owns: PLC and HMI must stay on distinct ports.
      const owned = runningInstancePorts(state.larsInstances, workspace.name);
      const effectivePort = result.running
        ? await resolveEffectiveOnlinePort([workspace.onlinePort, DEFAULT_ONLINE_PORT], owned, (p) => isLarsHealthy(p))
        : null;
      const healthy = effectivePort !== null;

      const inst = req.instance ?? getLarsInstance(state, workspace.name);
      if (inst) {
        inst.pid = result.pid ?? inst.pid;
        inst.onlinePort = workspace.onlinePort;
        inst.effectiveOnlinePort = effectivePort ?? undefined;
        setLarsInstance(state, inst);
        writeState(state);
      }

      return respond({
        ok: true,
        name: workspace.name,
        onlinePort: effectivePort ?? workspace.onlinePort,
        configuredOnlinePort: workspace.onlinePort,
        running: true,
        healthy,
        pid: result.pid,
        ...(autoCreated ? { autoCreated: true } : {}),
        hint: !healthy
          ? `LARS launched but no online port answered among [${workspace.onlinePort}, ${DEFAULT_ONLINE_PORT}]` +
            (owned.length ? ` (${owned.join(", ")} already owned by another running instance)` : "") +
            ". If this is a second parallel instance, note that the field-tested LARS 01.03.216 build exposes no online port for it — check the LARS installation or run one instance at a time."
          : autoCreated
            ? "Workspace was auto-created on demand (station known but unconfigured), then LARS started. Next: lars_runtime set_station_target to point the station's .lss at it."
            : "LARS is up. Next: lars_runtime set_station_target <workspace> so build_project/control_plc/plc_values target it.",
      });
    }

    if (action === "set_station_target") {
      const inst = req.instance;
      if (!inst?.stationLssPath) {
        return fail(`No station .lss known for workspace '${workspace.name}'.`, [
          "Run setup with the station linked first.",
        ]);
      }
      if (!existsSync(inst.stationLssPath)) {
        return fail(`Station .lss not found: ${inst.stationLssPath}`, []);
      }

      // Point the station at the port the instance actually services — never blindly at
      // the configured ONLINE value (that is exactly how stations ended up on dead ports).
      let port = inst.effectiveOnlinePort;
      if (port === undefined) {
        const owned = runningInstancePorts(state.larsInstances, workspace.name);
        port =
          (await resolveEffectiveOnlinePort(
            [workspace.onlinePort, DEFAULT_ONLINE_PORT],
            owned,
            (p) => isLarsHealthy(p),
            10_000,
          )) ?? undefined;
        if (port !== undefined) inst.effectiveOnlinePort = port;
      }
      const running = getLarsPids(workspace.name).length > 0;
      if (port === undefined && running) {
        return fail(
          `LARS workspace '${workspace.name}' is running but no online port answered among ` +
            `[${workspace.onlinePort}, ${DEFAULT_ONLINE_PORT}] — refusing to point the station at a dead port.`,
          [
            "If another LARS instance already owns a port, this workspace has none (parallel-instance issue).",
            "Check the LARS installation/window; a just-updated LARS may not expose the configured online port.",
          ],
        );
      }
      const targetPort = port ?? workspace.onlinePort;

      const result = pointStationAtLars(inst.stationLssPath, targetPort);
      if ("error" in result) return fail(result.error, []);
      if (inst.originalIp === undefined) {
        inst.originalIp = result.previousIp;
        inst.originalPort = result.previousPort;
      }
      setLarsInstance(state, inst);
      writeState(state);
      return respond({
        ok: true,
        workspace: workspace.name,
        station: inst.stationName,
        lssPath: inst.stationLssPath,
        nowTargeting: `127.0.0.1:${targetPort} (LARS)`,
        previousTarget: `${result.previousIp}:${result.previousPort}`,
        ...(port === undefined
          ? { warning: "LARS instance is not running — targeted the configured port; start the instance first." }
          : {}),
        hint: "Now build_project/control_plc/plc_values with no connection argument will hit LARS. Use 'restore' to revert.",
      });
    }

    if (action === "restore") {
      const inst = req.instance;
      if (!inst?.stationLssPath) return fail("No station .lss known for this workspace.", []);
      if (!inst.originalIp) return fail("No saved original target — set_station_target was never called.", []);
      if (!existsSync(inst.stationLssPath)) return fail(`Station .lss not found: ${inst.stationLssPath}`, []);
      const { updateLssConnection } = await import("../utils/projectScanner.js");
      updateLssConnection(inst.stationLssPath, { ip: inst.originalIp, port: inst.originalPort });
      const restored = { ip: inst.originalIp, port: inst.originalPort };
      inst.originalIp = undefined;
      inst.originalPort = undefined;

      // Also restore the .lcp compile target if it was switched to PC
      let targetRestored: string | null = null;
      if (inst.originalTargetTag && inst.lcpPath && existsSync(inst.lcpPath)) {
        const { restoreProjectTarget } = await import("../utils/lars.js");
        if (restoreProjectTarget(inst.lcpPath, inst.originalTargetTag)) {
          targetRestored = inst.originalTargetTag;
          inst.originalTargetTag = undefined;
        }
      }

      setLarsInstance(state, inst);
      writeState(state);
      return respond({ ok: true, workspace: workspace.name, restored, targetRestored });
    }

    if (action === "target_pc") {
      const inst = req.instance;
      if (!inst?.lcpPath) {
        return fail(`No .lcp known for workspace '${workspace.name}'.`, ["Run setup with the station linked first."]);
      }
      if (!existsSync(inst.lcpPath)) return fail(`Project .lcp not found: ${inst.lcpPath}`, []);
      const { switchProjectTargetToPC } = await import("../utils/lars.js");
      const result = switchProjectTargetToPC(inst.lcpPath);
      if ("error" in result) return fail(result.error, []);
      if (inst.originalTargetTag === undefined) {
        inst.originalTargetTag = result.previousTag;
      }
      setLarsInstance(state, inst);
      writeState(state);
      return respond({
        ok: true,
        workspace: workspace.name,
        station: inst.stationName ?? null,
        lcpPath: inst.lcpPath,
        targetBefore: result.previousTag,
        targetNow: result.newTag,
        hint: "Now run build_project compile, then build_project download (the .lss already points at LARS) to get the PC image running.",
      });
    }
  }

  if (action === "screenshot") {
    const req = requireWorkspace(args, state);
    if (req.error) return fail(req.error, []);
    const workspace = req.workspace!;

    const pids = getLarsPids(workspace.name);
    if (pids.length === 0) {
      return fail(`LARS workspace '${workspace.name}' is not running.`, ["Call lars_runtime start first."]);
    }

    ensureScratch();
    const safeName = workspace.name.replace(/[^A-Za-z0-9_.-]/g, "_");
    const outPath = join(SCRATCH, `lars_${safeName}_${Date.now()}.png`);
    const cap = captureLarsWindow(workspace.name, outPath);
    if (!cap.ok) {
      return fail(cap.error ?? "Screenshot failed.", [
        "Ensure the LARS window is visible (not minimized to tray) and the session is interactive.",
      ]);
    }

    let data = "";
    try {
      data = readFileSync(outPath).toString("base64");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`Screenshot was written but could not be read back: ${msg}`, []);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: true,
              workspace: workspace.name,
              screenshotPath: outPath,
              screenProjectPath: workspace.screenProjectPath ?? null,
              hint: "LARS renders LASAL SCREEN projects locally (SCREEN_PRJ_PATH workspaces). Capture again after UI state changes to verify visuals.",
            },
            null,
            2,
          ),
        },
        { type: "image" as const, data, mimeType: "image/png" },
      ],
    };
  }

  return fail(`Unknown action: ${action}`, []);
}
