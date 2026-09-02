import { z } from "zod";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  LARS_EXE,
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
  type LarsWorkspace,
} from "../utils/lars.js";
import { readState, writeState, getLarsInstance, setLarsInstance, removeLarsInstance, type LarsInstanceInfo, type LasalState } from "../state.js";
import { HMI_DIR, LARS_GC_MIN_AGE_H, LARS_GC_STATIONS_DIRS } from "../utils/config.js";
import { findLsmPath, parseSolution, readVisuStationIds } from "../utils/projectScanner.js";
import { respond, fail } from "../utils/respond.js";

export const larsRuntimeSchema = {
  action: z
    .enum(["list", "setup", "start", "stop", "remove", "set_station_target", "restore", "target_pc", "gc"])
    .describe(
      "'list' shows all configured LARS workspaces and their state (auto-cleans stale ones). " +
        "'setup' creates/updates LARS workspaces for the selected project's stations (or one station/lcp. " +
        "'start' launches a LARS instance (auto-creates the workspace first if the station is known but unconfigured), 'stop' terminates it, 'remove' deletes its workspace config. " +
        "'gc' runs lazy garbage collection: deletes auto-created workspaces that are not running and no longer referenced by any station .lss or published DataService stations.json. " +
        "'set_station_target' points a station's .lss at its LARS instance (127.0.0.1:<port>); 'restore' reverts to the saved real target. " +
        "'target_pc' switches an ARM-compiled .lcp to the PC (x86) compile target LARS requires (restore via 'restore')."
    ),
  name: z
    .string()
    .optional()
    .describe("LARS workspace name (e.g. 'VisuPalletizer_PLC'). Required for start/stop/remove/set_station_target/restore when station is omitted."),
  station: z
    .string()
    .optional()
    .describe("Station name from the solution (e.g. 'PLC', 'HMI', 'Local'). Picks the matching workspace. Mutually exclusive with name."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to a .lcp to create a workspace for (setup only, when no station name is usable)."),
  project_dir: z
    .string()
    .optional()
    .describe("Solution directory to auto-detect stations from (setup/list only. Defaults to the selected project."),
  dry_run: z
    .boolean()
    .optional()
    .describe("With action 'gc': report what would be removed without deleting anything. Default false."),
  min_age_h: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("With action 'gc': only delete workspaces unreferenced for at least this many hours (overrides LASAL_MCP_LARS_GC_MIN_AGE_H; 0 = immediately."),
};

type LarsAction = "list" | "setup" | "start" | "stop" | "remove" | "set_station_target" | "restore" | "target_pc" | "gc";

function detectRole(lcpPath: string): "plc" | "hmi" | "unknown" {
  try {
    const lcpDir = lcpPath.substring(0, lcpPath.lastIndexOf("\\"));
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
        role: detectStationRole(stn),
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function workspaceSummary(
  ws: LarsWorkspace,
  instances: Record<string, LarsInstanceInfo> | undefined
) {
  const inst = instances?.[ws.name];
  const pids = getLarsPids(ws.name);
  const running = pids.length > 0;
  return {
    name: ws.name,
    onlinePort: ws.onlinePort,
    comlinkServerPort: ws.comlinkServerPort,
    comlinkBasePort: ws.comlinkBasePort,
    alarmPort: ws.alarmPort,
    classProjectPath: ws.classProjectPath ?? null,
    screenProjectPath: ws.screenProjectPath ?? null,
    running,
    pid: pids[0] ?? inst?.pid ?? null,
    healthy: running ? await isLarsHealthy(ws.onlinePort) : false,
    stationName: inst?.stationName ?? null,
    lcpPath: inst?.lcpPath ?? null,
    lssPath: inst?.stationLssPath ?? null,
    role: inst?.role ?? null,
    targetedAtLars: inst?.originalIp ? true : false,
  };
}

function requireWorkspace(args: { name?: string; station?: string }): { workspace?: LarsWorkspace; instance?: LarsInstanceInfo; error?: string } {
  const state = readState();
  const workspaces = readLarsWorkspaces();
  const instances = state.larsInstances ?? {};

  if (args.name) {
    const workspace = workspaces.find((w) => w.name === args.name);
    if (!workspace) return { error: `No LARS workspace named '${args.name}' found. Use action 'setup' first.` };
    return { workspace, instance: instances[args.name] };
  }

  if (args.station) {
    const inst = Object.values(instances).find((i) => i.stationName === args.station);
    const workspace = inst ? workspaces.find((w) => w.name === inst.name) : undefined;
    if (!inst || !workspace) {
      return { error: `No LARS instance for station '${args.station}'. Use action 'setup' first.` };
    }
    return { workspace, instance: inst };
  }

  return { error: "Provide either 'name' (workspace name) or 'station' (station name)." };
}

function runAutoGc(state: LasalState, dryRun: boolean = false) {
  const result = gcLarsWorkspaces({
    dryRun,
    minAgeH: LARS_GC_MIN_AGE_H,
    dataDirs: [HMI_DIR, ...LARS_GC_STATIONS_DIRS],
    larsGc: state.larsGc,
    instances: state.larsInstances,
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
  state: LasalState
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
    return { error: `No LARS workspace named '${args.name}' found and no instance bookkeeping exists — run lars_runtime setup first.` };
  }

  if (args.station) {
    const inst = Object.values(state.larsInstances ?? {}).find((i) => i.stationName === args.station);
    if (inst) {
      const existing = workspaces.find((w) => w.name === inst.name);
      if (existing) return { workspace: existing, instance: inst };
      const { workspace } = upsertLarsWorkspace(inst.name, {
        ...(inst.lcpPath ? { classProjectPath: inst.lcpPath } : {}),
      });
      return { workspace, instance: inst, autoCreated: true };
    }

    // No bookkeeping — try to detectthe station from the solution and set it up now
    const projectDir = args.project_dir ?? state.currentProject;

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
    return { error: `No LARS instance for station '${args.station}' found and none detectable in the solution — run lars_runtime setup first.` };
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
}) {
  const state = readState();
  const action = args.action;

  if (action === "list") {
    // Lazy cleanup first: stale auto-created workspaces (not running, nothing points at them) are dropped automatically.

    const gcResult = runAutoGc(state);
    const projectDir = args.project_dir ?? state.currentProject;
    const workspaces = readLarsWorkspaces();
    const projectName = projectDir ? (projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "project") : null;
    const detected = projectDir ? detectStations(projectDir) : [];

    // Show detected-but-not-configured stations so the agent knows what to set up
    const unconfigured = detected
      .filter(
        (d) =>
          projectName === null ||
          !workspaces.some((w) => w.name === safeWorkspaceName(projectName, d.stationName))
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

    runAutoGc(state);

    const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "project";
    const stations = detectStations(projectDir);
    const created: Array<Record<string, unknown>> = [];

    // Map station names to their VISU stationIds (e.g. PLC -> 10, HMI -> 255) so the
    // published DataService stations.json (numeric `station` field) can be pointed at
    // the right LARS instance. Read from the first HMI/lvp station's Stations.json.
    const visuStationIds = resolveVisuStationIds(projectDir);

    if (args.lcp_path) {
      // Single lcp: build a workspace named after the project + lcp base
      const lcpBase = args.lcp_path.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.lcp$/i, "") ?? "project";
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
      if (!station) return fail(`Station '${args.station}' not found in ${projectDir}.`, ["Check lasal_status for the station list."]);
      const name = safeWorkspaceName(projectName, station.stationName);
      const { workspace } = upsertLarsWorkspace(name, {
        classProjectPath: station.lcpPath,
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
      created.push({ name: workspace.name, onlinePort: workspace.onlinePort, stationName: station.stationName, lcpPath: station.lcpPath, role: station.role });
    } else {
      for (const station of stations) {
        const name = safeWorkspaceName(projectName, station.stationName);
        const { workspace } = upsertLarsWorkspace(name, {
          classProjectPath: station.lcpPath,
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
        created.push({ name: workspace.name, onlinePort: workspace.onlinePort, stationName: station.stationName, lcpPath: station.lcpPath, role: station.role });
      }
      writeState(state);
    }

    if (created.length === 0) {
      return fail("No stations with .lcp projects found.", ["Ensure the solution has a .lsm file with station .lss files."]);
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

  if (action === "start" || action === "stop" || action === "remove" || action === "set_station_target" || action === "restore" || action === "target_pc") {
    // 'start' auto-creates the workspace when the station is known but unconfigured;
    // all other actions require an existing configured workspace.

    const req = action === "start" ? ensureWorkspaceForStart(args, state) : requireWorkspace(args);
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

      // Poll for online port availability (the runtime takes a moment to bind)
      let healthy = result.healthy;
      if (!healthy && result.running) {
        const start = Date.now();
        while (Date.now() - start < 8000) {
          await new Promise((r) => setTimeout(r, 500));
          healthy = await isLarsHealthy(workspace.onlinePort);
          if (healthy) break;
        }
      }

      const inst = req.instance ?? getLarsInstance(state, workspace.name);
      if (inst) {
        inst.pid = result.pid ?? inst.pid;
        inst.onlinePort = workspace.onlinePort;
        setLarsInstance(state, inst);
        writeState(state);
      }

return respond({
        ok: true,
        name: workspace.name,
        onlinePort: workspace.onlinePort,
        running: true,
        healthy,
        pid: result.pid,
        ...(autoCreated ? { autoCreated: true } : {}),
        hint: autoCreated
          ? "Workspace was auto-created on demand (station known but unconfigured), then LARS started. Next: set_station_target to point the station's .lss at it."
          : healthy
            ? "LARS is up. Next: lars_runtime set_station_target <workspace> so build_project/control_plc/plc_values target it."
            : "LARS launched but the online port is not answering yet — check the LARS window or lasal_status.",
      });
    }

    if (action === "set_station_target") {
      const inst = req.instance;
      if (!inst?.stationLssPath) {
        return fail(`No station .lss known for workspace '${workspace.name}'.`, ["Run setup with the station linked first."]);
      }
      if (!existsSync(inst.stationLssPath)) {
        return fail(`Station .lss not found: ${inst.stationLssPath}`, []);
      }
      const result = pointStationAtLars(inst.stationLssPath, workspace.onlinePort);
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
        nowTargeting: `127.0.0.1:${workspace.onlinePort} (LARS)`,
        previousTarget: `${result.previousIp}:${result.previousPort}`,
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

  return fail(`Unknown action: ${action}`, []);
}