import { existsSync } from "fs";
import { readState, getHmiForProject } from "../state.js";
import { findLsmPath, parseSolution, findLcpFiles, findLvpFiles } from "../utils/projectScanner.js";
import { CLASS2_EXE, VISUDESIGNER_EXE, resolveDataServiceExe, isProcessRunning, getProcessPid } from "../utils/engine.js";
import { pingHost } from "../utils/preflight.js";
import { LARS_EXE, readLarsWorkspaces, getLarsPids, isLarsHealthy, larsConfigPath } from "../utils/lars.js";
import { respond } from "../utils/respond.js";
import { checkHttpHealth } from "../core/http.js";

export const lasalStatusSchema = {};

export async function lasalStatusHandler() {
  const state = readState();
  const projDir = state.currentProject;

  const projectInfo = {
    selected: projDir,
    lcpPaths: projDir ? findLcpFiles(projDir) : [],
    lvpPaths: projDir ? findLvpFiles(projDir) : []
  };

  const stations: Array<Record<string, unknown>> = [];
  if (projDir) {
    const lsmPath = findLsmPath(projDir);
    if (lsmPath) {
      try {
        const soln = parseSolution(lsmPath);
        for (const stn of soln.stations) {
          const ip = stn.ip ?? "";
          let reachable = false;
          if (ip) {
            reachable = await pingHost(ip, parseInt(stn.port ?? "1954", 10) || 1954, 1000);
          }
          stations.push({
            name: stn.name,
            ip: stn.ip,
            port: stn.port ?? "1954",
            reachable,
            lcp: stn.lcpPaths[0] ?? null,
            lvp: stn.lvpPaths[0] ?? null
          });
        }
      } catch {}
    }
  }

  const dsResult = resolveDataServiceExe();

  const engines = {
    class2: { path: CLASS2_EXE, exists: existsSync(CLASS2_EXE) },
    visuDesigner: { path: VISUDESIGNER_EXE, exists: existsSync(VISUDESIGNER_EXE) },
    dataService: {
      path: dsResult.path,
      exists: dsResult.path ? existsSync(dsResult.path) : false,
      resolvedVia: process.env.LASAL_DATASERVICE_EXE ? ("env" as const) : ("glob" as const),
      ...(dsResult.path === "" ? { searched: dsResult.searched } : {}),
    },
    lars: {
      path: LARS_EXE,
      exists: existsSync(LARS_EXE),
      configPath: larsConfigPath(),
    }
  };

  const processes = {
    class2Running: isProcessRunning("Lasal2.exe"),
    visuDesignerRunning: isProcessRunning("VISUDesigner.exe"),
    dataServicePid: getProcessPid("LasalVISUDataService.exe")
  };

  // Check HMI runtime health (per project)
  const hmiRuntimeInfo = await (async () => {
    const running = getHmiForProject(state, projDir ?? undefined);
    if (running) {
      const pid = running.pid;
      const port = running.port;
      const url = running.url;
      const isRunning = processes.dataServicePid === pid;

      let healthy = false;
      if (isRunning && port) {
        healthy = await checkHttpHealth(`http://127.0.0.1:${port}/`);
      }

      return {
        running: isRunning,
        pid,
        port,
        url,
        healthy
      };
    }
    if (processes.dataServicePid) {
      // Found untracked DataService running
      return {
        running: true,
        pid: processes.dataServicePid,
        healthy: await checkHttpHealth(`http://127.0.0.1:9980/`) // Try standard port
      };
    }
    return { running: false };
  })();

  // LARS instances (from lasalos2.xml workspace config)
  const larsWorkspaces = readLarsWorkspaces();
  const larsInstances = state.larsInstances ?? {};
  const lars = {
    configured: larsWorkspaces.map((w) => {
      const inst = larsInstances[w.name];
      const pids = getLarsPids(w.name);
      const running = pids.length > 0;
      return {
        name: w.name,
        onlinePort: w.onlinePort,
        running,
        pid: pids[0] ?? inst?.pid ?? null,
        healthy: running ? isLarsHealthy(w.onlinePort) : false,
        stationName: inst?.stationName ?? null,
        lcpPath: inst?.lcpPath ?? null,
        targetedAtLars: inst?.originalIp ? true : false,
      };
    }),
  };

  const hints: string[] = [];
  if (!projDir) {
    hints.push("No project is currently selected. Use select_project with the path to your project folder first.");
  } else {
    if (stations.length === 0) {
      hints.push("No stations found. Check if the project is structured correctly with an .lsm file.");
    } else {
      const unreachable = stations.filter(s => !s.reachable);
      if (unreachable.length > 0) {
        const larsHints = lars.configured
          .filter((l) => l.running && l.stationName)
          .map((l) => l.stationName);
        hints.push(
          `Some stations are unreachable (${unreachable.map(u => u.name).join(", ")}). ` +
            (larsHints.length
              ? `LARS is running for: ${larsHints.join(", ")} — use lars_runtime set_station_target to point those stations at LARS.`
              : "No real PLC/HMI on the network? Use lars_runtime setup + start to simulate stations locally.")
        );
      }
    }
    if (processes.class2Running) {
      hints.push("CLASS 2 IDE is open. Close it manually or call manage_class2 close before running batch operations (compile/download).");
    }
  }

  return respond({
    ok: true,
    project: projectInfo,
    stations,
    engines,
    processes,
    hmiRuntime: hmiRuntimeInfo,
    lars,
    hints
  });
}