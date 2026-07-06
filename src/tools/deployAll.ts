import { z } from "zod";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { runBatchOps, runScript, emitPy27String, emitPath, buildRawScript } from "../utils/batchScript.js";
import { runVisuOps } from "../utils/visuScript.js";
import { resolveLcpPath, resolveLvpPath } from "../utils/resolvePaths.js";
import { withEngineLock } from "../utils/engine.js";
import { hmiRuntimeHandler } from "./hmiRuntime.js";
import { TIMEOUTS } from "../utils/config.js";
import { preflightPlc, preflightHmi, resolveConnection } from "../utils/preflight.js";
import { respond, fail } from "../utils/respond.js";
import { batchToStepResult, visuToStepResult, type StepResult } from "../core/response.js";
import { isTransientError } from "../core/errors.js";

export const deployAllSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  lvp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lvp file. Omit to auto-detect from the selected project."),
  plc_connection: z
    .string()
    .optional()
    .describe("PLC connection string (e.g. 'TCPIP:192.168.1.100'). Omit to use the connection saved in the project's .lss file."),
  visu_connection: z
    .string()
    .optional()
    .describe("HMI connection string (e.g. 'TCPIP:192.168.1.100'). Required when download_visu is true."),
  compile: z
    .boolean()
    .optional()
    .default(true)
    .describe("Compile the CLASS 2 project. Default true."),
  compile_options: z
    .enum(["RebuildAll", "BuildChanges"])
    .optional()
    .default("RebuildAll")
    .describe("Compile mode. RebuildAll is safest; BuildChanges is faster for incremental work."),
  download_plc: z
    .boolean()
    .optional()
    .default(true)
    .describe("Download the compiled CLASS 2 project to the PLC. Default true."),
  update_visu_stations: z
    .boolean()
    .optional()
    .default(true)
    .describe("Run update_all_stations on the VISUDesigner project to sync datapoints after CLASS 2 changes. Default true."),
  download_visu: z
    .boolean()
    .optional()
    .default(false)
    .describe("Download the VISUDesigner project to the HMI after updating stations. Requires visu_connection. Default false."),
  visu_download_flags: z
    .number()
    .int()
    .optional()
    .default(0)
    .describe("VISUDesigner download mode: 0=normal (default), 1=changes only, 2=publish+download changes."),
  add_plc_loader: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force loader download to PLC even if the target already has a compatible loader."),
  add_visu_runtime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force runtime download to HMI even if the version already matches."),
  start_plc: z
    .boolean()
    .optional()
    .default(true)
    .describe("Start the PLC runtime after a successful download. Default true."),
  start_hmi_runtime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Start the local HMI runtime (DataService) and copy HMI files after a successful compilation/update. Default false."),
  timeout_s: z
    .number()
    .int()
    .optional()
    .describe("Timeout override in seconds for compile and download steps."),
};


export async function deployAllHandler(args: {
  lcp_path?: string;
  lvp_path?: string;
  plc_connection?: string;
  visu_connection?: string;
  compile?: boolean;
  compile_options?: string;
  download_plc?: boolean;
  update_visu_stations?: boolean;
  download_visu?: boolean;
  visu_download_flags?: number;
  add_plc_loader?: boolean;
  add_visu_runtime?: boolean;
  start_plc?: boolean;
  start_hmi_runtime?: boolean;
  timeout_s?: number;
}) {
  return withEngineLock(async () => {
    const doCompile = args.compile ?? true;
    const doDownloadPlc = args.download_plc ?? true;
    const doStartPlc = doDownloadPlc && (args.start_plc ?? true);
    const doUpdateVisuStations = args.update_visu_stations ?? true;
    const doDownloadVisu = args.download_visu ?? false;

    const steps: Record<string, StepResult> = {};

    // Validate paths upfront
    let lcpPath: string | undefined;
    if (doCompile || doDownloadPlc) {
      const resolved = resolveLcpPath(args.lcp_path);
      if ("error" in resolved) {
        return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
      }
      lcpPath = resolved.path;
    }

    let lvpPath: string | undefined;
    if (doUpdateVisuStations || doDownloadVisu || args.start_hmi_runtime) {
      const resolved = resolveLvpPath(args.lvp_path);
      if ("error" in resolved) {
        return fail(resolved.error, ["Select a project first using select_project or specify lvp_path."]);
      }
      lvpPath = resolved.path;
    }

    if (doDownloadVisu && !args.visu_connection) {
      return fail("visu_connection is required when download_visu is true.", ["Provide visu_connection."]);
    }

    // Resolve connections and preflight upfront
    const plcConnectionInfo = resolveConnection(lcpPath!, args.plc_connection);
    const plcIp = plcConnectionInfo.ip ?? "";
    const plcConnectionUsed = plcConnectionInfo.connection;

    if (doDownloadPlc || doStartPlc) {
      const pfPlc = await preflightPlc(lcpPath!, args.plc_connection);
      if (!pfPlc.ok) {
        return respond({
          ok: false,
          preflightPlc: pfPlc,
          connections: {
            plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed }
          },
          errors: pfPlc.problems.map(p => p.message),
          hints: pfPlc.problems.map(p => p.fix)
        });
      }
    }

    let visuIp = "";
    if (doDownloadVisu) {
      const pfHmi = await preflightHmi(lvpPath!, args.visu_connection!);
      const m = args.visu_connection!.match(/TCPIP:(.+)/i);
      visuIp = m?.[1]?.split(":")[0] ?? args.visu_connection ?? "";
      if (!pfHmi.ok) {
        return respond({
          ok: false,
          preflightHmi: pfHmi,
          connections: {
            plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed },
            visu: { ip: visuIp, connection: args.visu_connection ?? "" }
          },
          errors: pfHmi.problems.map(p => p.message),
          hints: pfHmi.problems.map(p => p.fix)
        });
      }
    }

    function failResponse(msg?: string, hints: string[] = []) {
      const body: Record<string, unknown> = {
        ok: false,
        steps,
        connections: {
          plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed },
          ...(doDownloadVisu ? { visu: { ip: visuIp, connection: args.visu_connection ?? "" } } : {})
        },
        hints
      };
      if (msg) body.error = msg;
      return respond(body as any);
    }

    // Step 1: compile
    if (doCompile) {
      const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.compile;
      const br = await runBatchOps(lcpPath!, [{ type: "compile", optionName: args.compile_options ?? "RebuildAll" }], timeoutMs);
      steps.compile = batchToStepResult(br);
      if (!br.ok) return failResponse("Compilation step failed.", br.hints ?? []);
    }

    // Step 2: download PLC
    if (doDownloadPlc) {
      const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.download;
      let br = await runBatchOps(lcpPath!, [{
        type: "download",
        connection: plcConnectionUsed,
        addLoaderAnyway: args.add_plc_loader ?? false,
      }], timeoutMs);

      if (!br.ok && isTransientError(br.errors)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        br = await runBatchOps(lcpPath!, [{
          type: "download",
          connection: plcConnectionUsed,
          addLoaderAnyway: args.add_plc_loader ?? false,
        }], timeoutMs);
        br.hints = [...(br.hints ?? []), "Retried download once due to a transient connection failure."];
      }

      steps.download_plc = batchToStepResult(br);
      if (!br.ok) return failResponse("PLC download step failed.", br.hints ?? []);
    }

    // Step 2a: verify PLC after download
    if (doDownloadPlc) {
      const id = randomUUID();
      const logPath = join(tmpdir(), "lasal-mcp", `${id}.log`);
      const stepsPath = join(tmpdir(), "lasal-mcp", `${id}.steps`);
      const resultPath = join(tmpdir(), "lasal-mcp", `${id}.state.json`);
      const conn = plcConnectionUsed;
      const bodyLines = [
        "state_map = {}",
        "for attr_name in dir(batch.PLCStates):",
        "    if not attr_name.startswith('_'):",
        "        try: state_map[int(getattr(batch.PLCStates, attr_name))] = attr_name",
        "        except: pass",
        `state_val = batch.GetPlcState(prj, ${emitPy27String(conn)})`,
        "state_int = int(state_val)",
        "state_name = state_map.get(state_int, 'Unknown(%d)' % state_int)",
        "result = {'stateValue': state_int, 'stateName': state_name}",
        "import json",
        `f_state = open(${emitPath(resultPath)}, 'w')`,
        "json.dump(result, f_state)",
        "f_state.close()"
      ];

      const script = buildRawScript(lcpPath!, bodyLines, logPath, stepsPath, ["get_state"]);
      let br = await runScript(script, logPath, TIMEOUTS.script, ["get_state"]);

      let stateData: Record<string, unknown> = {};
      if (existsSync(resultPath)) {
        try { stateData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch {}
      }

      steps.verify_plc = {
        ...batchToStepResult(br),
        plcState: stateData
      } as any;

      if (!br.ok) return failResponse("PLC verification step failed.", br.hints ?? []);
    }

    // Step 2b: start PLC after download
    if (doStartPlc) {
      const id = randomUUID();
      const logPath = join(tmpdir(), "lasal-mcp", `${id}.log`);
      const stepsPath = join(tmpdir(), "lasal-mcp", `${id}.steps`);
      const resultPath = join(tmpdir(), "lasal-mcp", `${id}.state.json`);
      const conn = plcConnectionUsed;
      const bodyLines = [
        `batch.Start(prj, ${emitPy27String(conn)})`,
        "import time",
        "time.sleep(1.0)",
        "state_map = {}",
        "for attr_name in dir(batch.PLCStates):",
        "    if not attr_name.startswith('_'):",
        "        try: state_map[int(getattr(batch.PLCStates, attr_name))] = attr_name",
        "        except: pass",
        `state_val = batch.GetPlcState(prj, ${emitPy27String(conn)})`,
        "state_int = int(state_val)",
        "state_name = state_map.get(state_int, 'Unknown(%d)' % state_int)",
        "result = {'stateValue': state_int, 'stateName': state_name}",
        "import json",
        `f_state = open(${emitPath(resultPath)}, 'w')`,
        "json.dump(result, f_state)",
        "f_state.close()"
      ];
      const script = buildRawScript(lcpPath!, bodyLines, logPath, stepsPath, ["start"]);
      let br = await runScript(script, logPath, TIMEOUTS.script, ["start"]);

      if (!br.ok && isTransientError(br.errors)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        br = await runScript(script, logPath, TIMEOUTS.script, ["start"]);
        br.hints = [...(br.hints ?? []), "Retried start once due to a transient connection failure."];
      }

      let stateData: Record<string, unknown> = {};
      if (existsSync(resultPath)) {
        try { stateData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch {}
      }

      steps.start_plc = {
        ...batchToStepResult(br),
        postStartState: stateData
      } as any;

      if (!br.ok) return failResponse("PLC start step failed.", br.hints ?? []);
    }

    // Step 3: update visu stations + optional download
    if (doUpdateVisuStations || doDownloadVisu) {
      const visuOps: Parameters<typeof runVisuOps>[1] = [];
      if (doUpdateVisuStations) visuOps.push({ type: "update_all_stations" });
      if (doDownloadVisu) visuOps.push({
        type: "download",
        connection: args.visu_connection!,
        flags: args.visu_download_flags ?? 0,
        add_runtime: args.add_visu_runtime ?? false,
      });

      const vr = await runVisuOps(lvpPath!, visuOps, true, TIMEOUTS.visu);
      steps.visu = visuToStepResult(vr);
      if (!vr.ok) return failResponse("Visu designer operations step failed.", vr.hints ?? []);
    }

    // Step 4: start HMI runtime
    if (args.start_hmi_runtime) {
      const startStart = Date.now();
      const hmiRes = await hmiRuntimeHandler({ action: "start", lvp_path: lvpPath });
      steps.hmi_runtime = {
        ok: !hmiRes.isError,
        durationMs: Date.now() - startStart,
        ...(hmiRes.isError ? { errors: [ hmiRes.content[0]?.text ?? "Unknown error" ] } : { logTail: [ `HMI started: ${hmiRes.content[0]?.text ?? "started"}` ] })
      };
      if (hmiRes.isError) return failResponse("HMI runtime start step failed.");
    }

    return respond({
      ok: true,
      steps,
      connections: {
        plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed },
        ...(doDownloadVisu ? { visu: { ip: visuIp, connection: args.visu_connection ?? "" } } : {})
      }
    });
  });
}
