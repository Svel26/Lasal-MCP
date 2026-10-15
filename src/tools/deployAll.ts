import { z } from "zod";
import { join } from "path";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { runBatchOps, runScript, emitPy27String, emitPath, buildRawScript } from "../utils/batchScript.js";
import { runVisuOps } from "../utils/visuScript.js";
import { runLseOps } from "../utils/lseScript.js";
import { resolveLcpPath, resolveLvpPath, resolveLprPath } from "../utils/resolvePaths.js";
import { resolveStationForLpr } from "./lseProject.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";
import { startHmiRuntime } from "./hmiRuntime.js";
import { TIMEOUTS } from "../utils/config.js";
import { preflightPlc, preflightHmi, resolveConnection, shouldAddLoader, pingHost } from "../utils/preflight.js";
import { respond, fail } from "../utils/respond.js";
import { batchToStepResult, visuToStepResult, lseToStepResult, type StepResult } from "../core/response.js";
import { isTransientError } from "../core/errors.js";
import { ensureScratch } from "../core/scratch.js";
import { createProgressReporter, type McpExtra } from "../utils/mcpProgress.js";
import { startJob } from "../core/jobs.js";

export const deployAllSchema = {
  lcp_path: z.string().optional().describe("Absolute path to the .lcp file. Omit to use the selected project."),
  lvp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lvp file. Omit to auto-detect from the selected project."),
  plc_connection: z
    .string()
    .optional()
    .describe(
      "PLC connection string (e.g. 'TCPIP:192.168.1.100'). Omit to use the connection saved in the project's .lss file.",
    ),
  visu_connection: z
    .string()
    .optional()
    .describe("HMI connection string (e.g. 'TCPIP:192.168.1.100'). Required when download_visu is true."),
  compile: z.boolean().optional().default(true).describe("Compile the CLASS 2 project. Default true."),
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
    .describe(
      "Run update_all_stations on the VISUDesigner project to sync datapoints after CLASS 2 changes. Default true.",
    ),
  download_visu: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Download the VISUDesigner project to the HMI after updating stations. Requires visu_connection. Default false.",
    ),
  visu_download_flags: z
    .number()
    .int()
    .optional()
    .default(0)
    .describe("VISUDesigner download mode: 0=normal (default), 1=changes only, 2=publish+download changes."),
  add_plc_loader: z
    .boolean()
    .optional()
    .describe(
      "Force loader download to PLC even if the target already has a compatible loader. " +
        "Default: auto — sent for local LARS/loopback targets, skipped otherwise. Set false to disable, true to force.",
    ),
  add_visu_runtime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force runtime download to HMI even if the version already matches."),
  lse_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lpr (LASAL SCREEN) project. Omit to auto-detect from the selected project."),
  compile_lse: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Compile the LASAL SCREEN project (writes the Runtime output folder). Skipped when there is no .lpr. Default true.",
    ),
  download_lse: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Download the LASAL SCREEN project to its station (requires lse_connection or a station target in the solution). Default false.",
    ),
  lse_connection: z
    .string()
    .optional()
    .describe(
      "SCREEN download target, e.g. 'TCPIP:192.168.1.50'. Omit to resolve from the station that owns the .lpr.",
    ),
  lse_run: z
    .boolean()
    .optional()
    .default(true)
    .describe("Start the screen runtime on the target after download (Download & Run). Default true."),
  start_plc: z
    .boolean()
    .optional()
    .default(true)
    .describe("Start the PLC runtime after a successful download. Default true."),
  start_hmi_runtime: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Start the local HMI runtime (DataService) and copy HMI files after a successful compilation/update. Default false.",
    ),
  timeout_s: z.number().int().optional().describe("Timeout override in seconds for compile and download steps."),
  async: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Run in the background: returns { status: 'pending', jobId } — poll with check_job_status. Default false.",
    ),
};

export async function deployAllHandler(
  args: {
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
    lse_path?: string;
    compile_lse?: boolean;
    download_lse?: boolean;
    lse_connection?: string;
    lse_run?: boolean;
    start_plc?: boolean;
    start_hmi_runtime?: boolean;
    timeout_s?: number;
    async?: boolean;
  },
  extra?: McpExtra,
) {
  const reporter = createProgressReporter(extra, "lasal.deploy");
  const run = () =>
    withEngineLock(async () => {
      await reporter.report(5, 100, "Validating deployment paths and options...");
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

      // Resolve the LASAL SCREEN (.lpr) project — optional; projects without one skip the LSE steps.
      let lprPath: string | undefined;
      const compileLseWanted = args.compile_lse ?? true;
      if (compileLseWanted || args.download_lse || args.lse_path) {
        const resolvedLse = resolveLprPath(args.lse_path);
        if ("error" in resolvedLse) {
          if (args.download_lse || args.lse_path) {
            return fail(resolvedLse.error, [
              "Pass lse_path or ensure the solution has a station with a SlnScreenProject entry.",
            ]);
          }
        } else {
          lprPath = resolvedLse.path;
        }
      }
      const doCompileLse = !!lprPath && compileLseWanted;
      const doDownloadLse = !!lprPath && (args.download_lse ?? false);

      // Resolve connections and preflight upfront
      const plcConnectionInfo = lcpPath
        ? resolveConnection(lcpPath, args.plc_connection)
        : { connection: "", source: "none" as const, ip: undefined, port: undefined };
      const plcIp = plcConnectionInfo.ip ?? "";
      const plcConnectionUsed = plcConnectionInfo.connection;

      if (doDownloadPlc || doStartPlc) {
        const pfPlc = await preflightPlc(lcpPath!, args.plc_connection);
        if (!pfPlc.ok) {
          return respond({
            ok: false,
            preflightPlc: pfPlc,
            connections: {
              plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed },
            },
            errors: pfPlc.problems.map((p) => p.message),
            hints: pfPlc.problems.map((p) => p.fix),
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
              visu: { ip: visuIp, connection: args.visu_connection ?? "" },
            },
            errors: pfHmi.problems.map((p) => p.message),
            hints: pfHmi.problems.map((p) => p.fix),
          });
        }
      }

      function failResponse(msg?: string, hints: string[] = []) {
        const body: { ok: boolean; hints?: string[]; [k: string]: unknown } = {
          ok: false,
          steps,
          connections: {
            plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed },
            ...(doDownloadVisu ? { visu: { ip: visuIp, connection: args.visu_connection ?? "" } } : {}),
            ...(lprPath
              ? { lse: { lprPath, ...(doDownloadLse ? { connection: args.lse_connection ?? "" } : {}) } }
              : {}),
          },
          hints,
        };
        if (msg) body.error = msg;
        return respond(body);
      }

      // Step 1: compile
      if (doCompile) {
        await reporter.report(25, 100, "Compiling CLASS 2 project...");
        const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.compile;
        const br = await runBatchOps(
          lcpPath!,
          [{ type: "compile", optionName: args.compile_options ?? "RebuildAll" }],
          timeoutMs,
        );
        steps.compile = batchToStepResult(br);
        if (!br.ok) return failResponse("Compilation step failed.", br.hints ?? []);
      }

      // Step 2: download PLC
      if (doDownloadPlc) {
        await reporter.report(50, 100, `Downloading project to PLC (${plcConnectionUsed})...`);
        const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.download;
        // LARS (local runtime) targets need the PC loader or the download ends in "Linker_Error".
        const addLoaderAnyway = shouldAddLoader(args.add_plc_loader, plcConnectionInfo);
        let br = await runBatchOps(
          lcpPath!,
          [
            {
              type: "download",
              connection: plcConnectionUsed,
              addLoaderAnyway,
            },
          ],
          timeoutMs,
        );

        if (!br.ok && isTransientError(br.errors)) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          br = await runBatchOps(
            lcpPath!,
            [
              {
                type: "download",
                connection: plcConnectionUsed,
                addLoaderAnyway,
              },
            ],
            timeoutMs,
          );
          br.hints = [...(br.hints ?? []), "Retried download once due to a transient connection failure."];
        }

        steps.download_plc = batchToStepResult(br);
        if (!br.ok) return failResponse("PLC download step failed.", br.hints ?? []);
      }

      // Step 2a: verify PLC after download
      if (doDownloadPlc) {
        await reporter.report(65, 100, "Verifying PLC status...");
        ensureScratch();
        const id = randomUUID();
        const logPath = join(SCRATCH, `${id}.log`);
        const stepsPath = join(SCRATCH, `${id}.steps`);
        const resultPath = join(SCRATCH, `${id}.state.json`);
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
          "f_state.close()",
        ];

        const script = buildRawScript(lcpPath!, bodyLines, logPath, stepsPath, ["get_state"]);
        let br = await runScript(script, logPath, TIMEOUTS.script, ["get_state"], stepsPath);

        let stateData: Record<string, unknown> = {};
        if (existsSync(resultPath)) {
          try {
            stateData = JSON.parse(readFileSync(resultPath, "utf-8"));
          } catch {}
        }

        steps.verify_plc = {
          ...batchToStepResult(br),
          plcState: stateData,
        };

        if (!br.ok) return failResponse("PLC verification step failed.", br.hints ?? []);
      }

      // Step 2b: start PLC after download
      if (doStartPlc) {
        await reporter.report(75, 100, "Starting PLC runtime...");
        ensureScratch();
        const id = randomUUID();
        const logPath = join(SCRATCH, `${id}.log`);
        const stepsPath = join(SCRATCH, `${id}.steps`);
        const resultPath = join(SCRATCH, `${id}.state.json`);
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
          "f_state.close()",
        ];
        const script = buildRawScript(lcpPath!, bodyLines, logPath, stepsPath, ["start"]);
        let br = await runScript(script, logPath, TIMEOUTS.script, ["start"], stepsPath);

        if (!br.ok && isTransientError(br.errors)) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          br = await runScript(script, logPath, TIMEOUTS.script, ["start"], stepsPath);
          br.hints = [...(br.hints ?? []), "Retried start once due to a transient connection failure."];
        }

        let stateData: Record<string, unknown> = {};
        if (existsSync(resultPath)) {
          try {
            stateData = JSON.parse(readFileSync(resultPath, "utf-8"));
          } catch {}
        }

        steps.start_plc = {
          ...batchToStepResult(br),
          postStartState: stateData,
        };

        if (!br.ok) return failResponse("PLC start step failed.", br.hints ?? []);
      }

      // Step 2c: compile LASAL SCREEN project (LSE)
      if (doCompileLse) {
        await reporter.report(78, 100, "Compiling LASAL SCREEN project...");
        const lseTimeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.lse;
        const lr = await runLseOps(lprPath!, [{ type: "compile" }], { saveAtEnd: true, timeoutMs: lseTimeoutMs });
        steps.compile_lse = lseToStepResult(lr);
        if (!lr.ok) return failResponse("LASAL SCREEN compile step failed.", lr.hints);
      }

      // Step 2d: download LASAL SCREEN project (LSE)
      if (doDownloadLse) {
        let lseConn = args.lse_connection;
        if (!lseConn) {
          const owner = resolveStationForLpr(lprPath!);
          if (owner?.ip) {
            lseConn = `TCPIP:${owner.ip}${owner.port && owner.port !== "1954" ? `:${owner.port}` : ""}`;
          }
        }
        if (!lseConn) {
          return failResponse(
            "Could not resolve a SCREEN download target. Pass lse_connection or register the .lpr in a station .lss.",
            ["Example: lse_connection: 'TCPIP:192.168.1.50'."],
          );
        }
        const lseIp = lseConn.replace(/^TCPIP:/i, "").split(":")[0] ?? "";
        const lsePort = parseInt(lseConn.split(":").pop() ?? "1954", 10) || 1954;
        await reporter.report(80, 100, `Downloading LASAL SCREEN project (${lseConn})...`);
        const lseReachable = await pingHost(lseIp, lsePort, 2000);
        if (!lseReachable) {
          return failResponse(`LASAL SCREEN target ${lseIp}:${lsePort} is unreachable.`, [
            "Check the station power/network, or simulate locally with lars_runtime (LARS renders LASAL SCREEN projects).",
          ]);
        }
        const lseTimeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.lse;
        const lr = await runLseOps(lprPath!, [{ type: "download", run: args.lse_run ?? true, connection: lseConn }], {
          saveAtEnd: false,
          timeoutMs: lseTimeoutMs,
        });
        steps.download_lse = lseToStepResult(lr);
        if (!lr.ok) return failResponse("LASAL SCREEN download step failed.", lr.hints);
      }

      // Step 3: update visu stations + optional download
      if (doUpdateVisuStations || doDownloadVisu) {
        await reporter.report(85, 100, "Updating VISU stations...");
        const visuOps: Parameters<typeof runVisuOps>[1] = [];
        if (doUpdateVisuStations) visuOps.push({ type: "update_all_stations" });
        if (doDownloadVisu)
          visuOps.push({
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
        await reporter.report(95, 100, "Starting HMI web simulation runtime...");
        const startStart = Date.now();
        const hmiRes = await startHmiRuntime({ action: "start", lvp_path: lvpPath });
        steps.hmi_runtime = {
          ok: !hmiRes.isError,
          durationMs: Date.now() - startStart,
          ...(hmiRes.isError
            ? { errors: [hmiRes.content[0]?.text ?? "Unknown error"] }
            : { logTail: [`HMI started: ${hmiRes.content[0]?.text ?? "started"}`] }),
        };
        if (hmiRes.isError) return failResponse("HMI runtime start step failed.");
      }

      await reporter.report(100, 100, "Deployment completed.");
      return respond({
        ok: true,
        steps,
        connections: {
          plc: { ip: plcIp, source: plcConnectionInfo.source, connection: plcConnectionUsed },
          ...(doDownloadVisu ? { visu: { ip: visuIp, connection: args.visu_connection ?? "" } } : {}),
          ...(lprPath ? { lse: { lprPath, ...(doDownloadLse ? { connection: args.lse_connection ?? "" } : {}) } } : {}),
        },
      });
    });

  if (args.async) {
    const job = startJob("deploy_all", run, (rec) => {
      void reporter.log("info", {
        jobId: rec.id,
        job: rec.name,
        status: rec.status,
        durationMs: rec.durationMs,
        ...(rec.error ? { error: rec.error } : {}),
        hint: "Background job finished — call check_job_status with this jobId for the result.",
      });
    });
    return respond({
      ok: true,
      status: "pending",
      jobId: job.id,
      hints: [
        "This call only STARTED the job in the background — it returned before doing any work.",
        "You MUST call check_job_status with this jobId repeatedly until it reports status 'completed' or 'failed'; the actual result is delivered there.",
      ],
    });
  }
  return run();
}
