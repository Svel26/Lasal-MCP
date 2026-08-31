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
  type LarsWorkspace,
} from "../utils/lars.js";
import { readState, writeState, getLarsInstance, setLarsInstance, removeLarsInstance, type LarsInstanceInfo } from "../state.js";
import { findLsmPath, parseSolution, readLssConnection } from "../utils/projectScanner.js";
import { respond, fail } from "../utils/respond.js";

export const larsRuntimeSchema = {
  action: z
    .enum(["list", "setup", "start", "stop", "remove", "set_station_target", "restore", "target_pc"])
    .describe(
      "'list' shows all configured LARS workspaces and their state. " +
        "'setup' creates/updates LARS workspaces for the selected project's stations (or one station/lcp). " +
        "'start' launches a LARS instance, 'stop' terminates it, 'remove' deletes its workspace config. " +
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
    .describe("Solution directory to auto-detect stations from (setup/list only). Defaults to the selected project."),
};

type LarsAction = "list" | "setup" | "start" | "stop" | "remove" | "set_station_target" | "restore" | "target_pc";

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
  role: "plc" | "hmi" | "unknown";
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
        role: detectStationRole(stn),
      });
    }
    return result;
  } catch {
    return [];
  }
}

function workspaceSummary(
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
    healthy: running ? isLarsHealthy(ws.onlinePort) : false,
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

export async function larsRuntimeHandler(args: {
  action: LarsAction;
  name?: string;
  station?: string;
  lcp_path?: string;
  project_dir?: string;
}) {
  const state = readState();
  const action = args.action;

  if (action === "list") {
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
      workspaces: workspaces.map((w) => workspaceSummary(w, state.larsInstances)),
      ...(unconfigured.length ? { unconfiguredStations: unconfigured } : {}),
      hint: "Call lars_runtime setup to create workspaces for all stations, then start + set_station_target per station.",
    });
  }

  if (action === "setup") {
    const projectDir = args.project_dir ?? state.currentProject;
    if (!projectDir) {
      return fail("No project selected.", ["Call select_project first or pass project_dir."]);
    }

    const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? "project";
    const stations = detectStations(projectDir);
    const created: Array<Record<string, unknown>> = [];

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

  if (action === "start" || action === "stop" || action === "remove" || action === "set_station_target" || action === "restore" || action === "target_pc") {
    const req = requireWorkspace(args);
    if (req.error) return fail(req.error, []);
    const workspace = req.workspace!;

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
        hint: healthy
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