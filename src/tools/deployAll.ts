import { z } from "zod";
import { runBatchOps, BatchResult } from "../utils/batchScript.js";
import { runVisuOps, VisuResult } from "../utils/visuScript.js";
import { resolveLcpPath, resolveLvpPath } from "../utils/resolvePaths.js";

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
};

type StepResult = {
  ok: boolean;
  durationMs: number;
  errors?: string[];
  warnings?: string[];
  logPath?: string;
};

function batchToStep(br: BatchResult): StepResult {
  return {
    ok: br.ok,
    durationMs: br.durationMs,
    ...(br.errors.length ? { errors: br.errors } : {}),
    ...(br.warnings.length ? { warnings: br.warnings } : {}),
    logPath: br.logPath,
  };
}

function visuToStep(vr: VisuResult): StepResult {
  return {
    ok: vr.ok,
    durationMs: vr.durationMs,
    ...(vr.errors.length ? { errors: vr.errors } : {}),
    ...(vr.warnings.length ? { warnings: vr.warnings } : {}),
    logPath: vr.logPath,
  };
}

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
}) {
  const doCompile = args.compile ?? true;
  const doDownloadPlc = args.download_plc ?? true;
  const doUpdateVisuStations = args.update_visu_stations ?? true;
  const doDownloadVisu = args.download_visu ?? false;

  const steps: Record<string, StepResult> = {};

  // Validate paths upfront before starting any destructive steps
  let lcpPath: string | undefined;
  if (doCompile || doDownloadPlc) {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) {
      return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
    }
    lcpPath = resolved.path;
  }

  let lvpPath: string | undefined;
  if (doUpdateVisuStations || doDownloadVisu) {
    const resolved = resolveLvpPath(args.lvp_path);
    if ("error" in resolved) {
      return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
    }
    lvpPath = resolved.path;
  }

  if (doDownloadVisu && !args.visu_connection) {
    return {
      content: [{ type: "text" as const, text: "visu_connection is required when download_visu is true." }],
      isError: true,
    };
  }

  function fail(msg?: string) {
    const body: Record<string, unknown> = { ok: false, steps };
    if (msg) body.error = msg;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      isError: true as const,
    };
  }

  // Step 1: compile
  if (doCompile) {
    const br = runBatchOps(lcpPath!, [{ type: "compile", optionName: args.compile_options ?? "RebuildAll" }]);
    steps.compile = batchToStep(br);
    if (!br.ok) return fail();
  }

  // Step 2: download PLC
  if (doDownloadPlc) {
    const br = runBatchOps(lcpPath!, [{
      type: "download",
      connection: args.plc_connection ?? "",
      addLoaderAnyway: args.add_plc_loader ?? false,
    }]);
    steps.download_plc = batchToStep(br);
    if (!br.ok) return fail();
  }

  // Step 3: update visu stations + optional download (single VISUDesigner session)
  if (doUpdateVisuStations || doDownloadVisu) {
    const visuOps: Parameters<typeof runVisuOps>[1] = [];
    if (doUpdateVisuStations) visuOps.push({ type: "update_all_stations" });
    if (doDownloadVisu) visuOps.push({
      type: "download",
      connection: args.visu_connection!,
      flags: args.visu_download_flags ?? 0,
      add_runtime: args.add_visu_runtime ?? false,
    });

    const vr = runVisuOps(lvpPath!, visuOps);
    steps.visu = visuToStep(vr);
    if (!vr.ok) return fail();
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, steps }, null, 2) }],
  };
}
