import { z } from "zod";
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { readState, writeState } from "../state.js";
import { DATASERVICE_EXE, killDataService, withEngineLock } from "../utils/engine.js";
import { resolveLvpPath } from "../utils/resolvePaths.js";
import { runVisuOps } from "../utils/visuScript.js";

export const hmiRuntimeSchema = {
  action: z.enum(["start", "stop", "status"]).describe("Action to perform on the HMI runtime DataService."),
  lvp_path: z.string().optional().describe("Absolute path to the .lvp file. Omit to use the currently selected project."),
  debugPublish: z.boolean().optional().default(true).describe("Use debug publish (requires TypeScript project support). Fallback to standard publish on failure. Default true."),
  publishFirst: z.boolean().optional().default(true).describe("Publish the project before starting the DataService. Default true."),
};

function copyDirSync(src: string, dest: string) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const item of readdirSync(src)) {
    const srcPath = join(src, item);
    const destPath = join(dest, item);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function createJunction(src: string, dest: string) {
  if (existsSync(dest)) {
    try {
      execSync(`rmdir "${dest}"`, { stdio: "pipe" });
    } catch {
      try {
        unlinkSync(dest);
      } catch {}
    }
  }
  execSync(`mklink /J "${dest}" "${src}"`, { stdio: "pipe" });
}

function getPortForPid(pid: number): number {
  try {
    const out = execSync(`powershell -Command "(Get-NetTCPConnection -OwningProcess ${pid} -State Listen).Port"`, { encoding: "utf-8" }).trim();
    const ports = out.split(/[\r\n]+/).map(p => parseInt(p.trim())).filter(p => !isNaN(p) && p > 0);
    if (ports.length > 0) {
      ports.sort((a, b) => a - b);
      return ports[0];
    }
  } catch {}
  return 9980;
}

function isPidRunning(pid: number): boolean {
  try {
    execSync(`tasklist /FI "PID eq ${pid}" | findstr ${pid}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function hmiRuntimeHandler(args: {
  action: "start" | "stop" | "status";
  lvp_path?: string;
  debugPublish?: boolean;
  publishFirst?: boolean;
}) {
  const state = readState();

  if (args.action === "stop") {
    const running = state.hmiRuntime;
    if (running) {
      killDataService(running.pid);
      state.hmiRuntime = undefined;
      writeState(state);
      return { content: [{ type: "text" as const, text: `HMI runtime DataService (PID ${running.pid}) stopped.` }] };
    } else {
      killDataService();
      return { content: [{ type: "text" as const, text: "No tracked HMI runtime running. Attempted global process kill." }] };
    }
  }

  if (args.action === "status") {
    const running = state.hmiRuntime;
    if (running && isPidRunning(running.pid)) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ running: true, ...running }, null, 2)
        }]
      };
    } else {
      if (running) {
        state.hmiRuntime = undefined;
        writeState(state);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ running: false }, null, 2) }] };
    }
  }

  // action === "start"
  const resolved = resolveLvpPath(args.lvp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  // 1. Publish first if requested
  if (args.publishFirst ?? true) {
    let debug = args.debugPublish ?? true;
    let publishResult = runVisuOps(resolved.path, [{ type: "publish", debug }]);
    if (!publishResult.ok && debug) {
      console.warn("Debug publish failed (possibly due to disabled TypeScript). Retrying with standard publish...");
      publishResult = runVisuOps(resolved.path, [{ type: "publish", debug: false }]);
    }
    if (!publishResult.ok) {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to publish project before starting HMI runtime: ${publishResult.errors.join("\n")}`
        }],
        isError: true,
      };
    }
  }

  // 2. Discover published folders
  const visuDir = resolved.path.substring(0, resolved.path.lastIndexOf("\\"));
  const webrootSrc = join(visuDir, "TempPreview", "Publish", "webroot");
  const dataSrc = join(visuDir, "TempPreview", "Publish", "dataservice", "data");

  if (!existsSync(webrootSrc)) {
    return { content: [{ type: "text" as const, text: `Published webroot not found at: ${webrootSrc}. Run HMI publish first.` }], isError: true };
  }

  // 3. Prepare C:\lslvisu
  const dataDir = "C:\\lslvisu";
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    
    // Copy webroot files
    copyDirSync(webrootSrc, dataDir);

    // Copy dataservice data if available
    if (existsSync(dataSrc)) {
      copyDirSync(dataSrc, join(dataDir, "dataservice", "data"));
    }

    // Link rt folder
    const visuDesignerDir = DATASERVICE_EXE.substring(0, DATASERVICE_EXE.indexOf("\\Lasal VISUDesigner"));
    const rtSrc = join(visuDesignerDir, "SIGMATEK", "Lasal", "VISUDesigner", "Runtime", "rt");
    if (existsSync(rtSrc)) {
      createJunction(rtSrc, join(dataDir, "rt"));
    } else {
      console.warn(`Warning: VISUDesigner Runtime 'rt' directory not found at ${rtSrc}. Paths starting with 'rt/' might fail to resolve.`);
    }

    // Create logs dir
    const logDir = join(dataDir, "dataservice", "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    // 4. Ensure stations.json is Intern
    const stationsJsonPath = join(dataDir, "dataservice", "data", "stations.json");
    if (existsSync(stationsJsonPath)) {
      try {
        const stations = JSON.parse(readFileSync(stationsJsonPath, "utf-8"));
        if (Array.isArray(stations.stations)) {
          for (const s of stations.stations) {
            s.conType = "INTERN";
          }
          writeFileSync(stationsJsonPath, JSON.stringify(stations, null, 2), "utf-8");
        }
      } catch {}
    }

    // 5. Patch config.json
    const configPath = join(dataDir, "dataservice", "config.json");
    const dataConfigPath = join(dataDir, "dataservice", "data", "config.json");
    const configContent = {
      WindowsAutoExit: false,
      WSAccessLog: true,
      WSErrorLog: true,
      LogDir: logDir,
    };
    writeFileSync(configPath, JSON.stringify(configContent, null, 2), "utf-8");
    if (existsSync(join(dataDir, "dataservice", "data"))) {
      writeFileSync(dataConfigPath, JSON.stringify(configContent, null, 2), "utf-8");
    }
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Failed to set up HMI runtime directory C:\\lslvisu: ${e.message}` }], isError: true };
  }

  // 6. Kill any existing instance
  if (state.hmiRuntime) {
    killDataService(state.hmiRuntime.pid);
  } else {
    killDataService();
  }

  // 7. Spawn DataService detached
  if (!existsSync(DATASERVICE_EXE)) {
    return { content: [{ type: "text" as const, text: `LasalVISUDataService.exe not found at standard path: ${DATASERVICE_EXE}` }], isError: true };
  }

  try {
    const child = spawn(DATASERVICE_EXE, [], {
      cwd: dataDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    if (!pid) {
      return { content: [{ type: "text" as const, text: "Failed to spawn LasalVISUDataService.exe process." }], isError: true };
    }
    child.unref();

    // Wait a brief moment for startup and discover port
    await new Promise(resolve => setTimeout(resolve, 2000));
    const port = getPortForPid(pid);
    const url = "file:///C:/lslvisu/index.html";

    state.hmiRuntime = { pid, port, url, dataDir };
    writeState(state);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ success: true, pid, port, url }, null, 2)
      }]
    };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Failed to launch HMI runtime: ${e.message}` }], isError: true };
  }
}
