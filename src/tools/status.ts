import { existsSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { readState } from "../state.js";
import { findLsmPath, parseSolution, findLcpFiles, findLvpFiles } from "../utils/projectScanner.js";
import { CLASS2_EXE, VISUDESIGNER_EXE, resolveDataServiceExe, DATASERVICE_SEARCHED, isProcessRunning, getProcessPid } from "../utils/engine.js";
import { pingHost } from "../utils/preflight.js";
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

  const stations: any[] = [];
  if (projDir) {
    const lsmPath = findLsmPath(projDir);
    if (lsmPath) {
      try {
        const soln = parseSolution(lsmPath);
        for (const stn of soln.stations) {
          const ip = stn.ip ?? "";
          let reachable = false;
          if (ip) {
            reachable = await pingHost(ip, 1954, 1000);
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
    }
  };

  const processes = {
    class2Running: isProcessRunning("Lasal2.exe"),
    visuDesignerRunning: isProcessRunning("VISUDesigner.exe"),
    dataServicePid: getProcessPid("LasalVISUDataService.exe")
  };

  // Check HMI runtime health
  let hmiRuntimeInfo: any = { running: false };
  if (state.hmiRuntime) {
    const pid = state.hmiRuntime.pid;
    const port = state.hmiRuntime.port;
    const url = state.hmiRuntime.url;
    const isRunning = processes.dataServicePid === pid;
    
    let healthy = false;
    if (isRunning && port) {
      healthy = await checkHttpHealth(`http://127.0.0.1:${port}/`);
    }
    
    hmiRuntimeInfo = {
      running: isRunning,
      pid,
      port,
      url,
      healthy
    };
  } else if (processes.dataServicePid) {
    // Found untracked DataService running
    hmiRuntimeInfo = {
      running: true,
      pid: processes.dataServicePid,
      healthy: await checkHttpHealth(`http://127.0.0.1:9980/`) // Try standard port
    };
  }

  const hints: string[] = [];
  if (!projDir) {
    hints.push("No project is currently selected. Use select_project with the path to your project folder first.");
  } else {
    if (stations.length === 0) {
      hints.push("No stations found. Check if the project is structured correctly with an .lsm file.");
    } else {
      const unreachable = stations.filter(s => !s.reachable);
      if (unreachable.length > 0) {
        hints.push(`Some stations are unreachable (${unreachable.map(u => u.name).join(", ")}). Check power/cables or set their IP via set_target_ip.`);
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
    hints
  });
}
