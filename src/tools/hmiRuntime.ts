import { z } from "zod";
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { readState, writeState, getHmiForProject, setHmiForProject, clearHmiForProject } from "../state.js";
import { DATASERVICE_EXE, killDataService, withEngineLock } from "../utils/engine.js";
import { resolveLvpPath } from "../utils/resolvePaths.js";
import { runVisuOps } from "../utils/visuScript.js";
import { respond, fail } from "../utils/respond.js";
import { checkHttpHealth } from "../core/http.js";
import { isPidRunning, getPortForPid } from "../core/process.js";
import { startStaticServer, stopStaticServer } from "../core/staticServer.js";

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


export async function startHmiRuntime(args: {
  action: "start" | "stop" | "status";
  lvp_path?: string;
  debugPublish?: boolean;
  publishFirst?: boolean;
}) {
    const state = readState();
    const warnings: string[] = [];

    if (args.action === "stop") {
      stopStaticServer();
      const running = getHmiForProject(state);
      if (running) {
        killDataService(running.pid);
        clearHmiForProject(state);
        writeState(state);
        return respond({ ok: true, message: `HMI runtime DataService (PID ${running.pid}) stopped.` });
      } else {
        killDataService();
        return respond({ ok: true, message: "No tracked HMI runtime running. Attempted global process kill." });
      }
    }

    if (args.action === "status") {
      const running = getHmiForProject(state);
      if (running && isPidRunning(running.pid)) {
        const healthy = await checkHttpHealth(`http://127.0.0.1:${running.port}/`, 1000, true);
        // Make sure the static web server is up (it dies with the MCP process, unlike the DataService)
        let url = running.url;
        try {
          const httpPort = await startStaticServer(running.dataDir);
          url = `http://127.0.0.1:${httpPort}/index.html`;
        } catch {}
        return respond({ ok: true, running: true, healthy, ...running, url });
      } else {
        if (running) {
          clearHmiForProject(state);
          writeState(state);
        }
        return respond({ ok: true, running: false });
      }
    }

    // action === "start"
    const resolved = resolveLvpPath(args.lvp_path);
    if ("error" in resolved) {
      return fail(resolved.error, ["Select a project first using select_project or specify lvp_path."]);
    }

    // 1. Publish first if requested
    if (args.publishFirst ?? true) {
      let debug = args.debugPublish ?? true;
      let publishResult = await runVisuOps(resolved.path, [{ type: "publish", debug }]);
      if (!publishResult.ok && debug) {
        warnings.push("Debug publish failed (possibly due to disabled TypeScript). Retrying with standard publish...");
        publishResult = await runVisuOps(resolved.path, [{ type: "publish", debug: false }]);
      }
      if (!publishResult.ok) {
        return fail(`Failed to publish project before starting HMI runtime: ${publishResult.errors.join("\n")}`, []);
      }
    }

    // 2. Discover published folders
    const visuDir = resolved.path.substring(0, resolved.path.lastIndexOf("\\"));
    const webrootSrc = join(visuDir, "TempPreview", "Publish", "webroot");
    const dataSrc = join(visuDir, "TempPreview", "Publish", "dataservice", "data");

    if (!existsSync(webrootSrc)) {
      return fail(`Published webroot not found at: ${webrootSrc}. Run HMI publish first.`, []);
    }

    // 3. Prepare HMI Dir (with override support)
    const { HMI_DIR } = await import("../utils/config.js");
    const dataDir = HMI_DIR;
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
        try {
          createJunction(rtSrc, join(dataDir, "rt"));
        } catch (e: any) {
          warnings.push(`Warning: Failed to create junction for 'rt' directory: ${e.message}`);
        }
      } else {
        warnings.push(`Warning: VISUDesigner Runtime 'rt' directory not found at ${rtSrc}. Paths starting with 'rt/' might fail to resolve.`);
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

      // 4b. Point the HMI frontend's WebSocket at the local DataService instead of the real panel
      const dsconfigPath = join(dataDir, "res", "data", "dsconfig.json");
      if (existsSync(dsconfigPath)) {
        try {
          const dsconfig = JSON.parse(readFileSync(dsconfigPath, "utf-8"));
          dsconfig.ip = "127.0.0.1";
          writeFileSync(dsconfigPath, JSON.stringify(dsconfig), "utf-8");
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
      return fail(`Failed to set up HMI runtime directory ${dataDir}: ${e.message}`, []);
    }

    // 6. Kill any existing instance
    const existing = getHmiForProject(state);
    if (existing) {
      killDataService(existing.pid);
    } else {
      killDataService();
    }

    // 7. Spawn DataService detached
    if (!existsSync(DATASERVICE_EXE)) {
      return fail(`LasalVISUDataService.exe not found at standard path: ${DATASERVICE_EXE}`, ["Make sure VISUDesigner is installed properly."]);
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
        return fail("Failed to spawn LasalVISUDataService.exe process.", []);
      }
      child.unref();

      // Poll HTTP health up to 10 seconds to detect startup and discover port
      let healthy = false;
      let port = 9980;
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        const discoveredPort = getPortForPid(pid);
        if (discoveredPort) {
          port = discoveredPort;
        }
        const isHealthy = await checkHttpHealth(`http://127.0.0.1:${port}/`, 1000, true);
        if (isHealthy) {
          healthy = true;
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // The DataService only speaks WebSocket (9980) and a binary protocol (9981), and the
      // webroot can't be opened via file:// (ES-module CORS) — serve it over local HTTP.
      let url: string;
      try {
        const httpPort = await startStaticServer(dataDir);
        url = `http://127.0.0.1:${httpPort}/index.html`;
      } catch (e: any) {
        warnings.push(`Failed to start static web server: ${e.message}. Falling back to file:// URL.`);
        url = `file:///${dataDir.replace(/\\/g, "/")}/index.html`;
      }

      setHmiForProject(state, { pid, port, url, dataDir });
      writeState(state);

      return respond({
        ok: true,
        success: true,
        pid,
        port,
        url,
        healthy,
        ...(warnings.length ? { warnings } : {})
      });
    } catch (e: any) {
      return fail(`Failed to launch HMI runtime: ${e.message}`, []);
    }
}

export async function hmiRuntimeHandler(args: {
  action: "start" | "stop" | "status";
  lvp_path?: string;
  debugPublish?: boolean;
  publishFirst?: boolean;
}) {
  return withEngineLock(() => startHmiRuntime(args));
}
