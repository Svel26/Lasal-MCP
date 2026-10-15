import { z } from "zod";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { runScript, emitPy27String, emitPath, type BatchResult } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";
import { XMLParser } from "fast-xml-parser";

function batchResultToResponse(br: BatchResult, extra?: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    ok: br.ok,
    durationMs: br.durationMs,
    ...(br.errors.length ? { errors: br.errors } : {}),
    ...(br.warnings.length ? { warnings: br.warnings } : {}),
    ...(br.logTail.length ? { logTail: br.logTail } : {}),
    logPath: br.logPath,
    ...extra,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(br.ok ? {} : { isError: true }),
  };
}

export const plcDiagnosticsSchema = {
  action: z
    .enum([
      "trace",
      "file_upload",
      "file_download",
      "file_delete",
      "code_analysis",
      "download_os",
      "clear_ram_image",
      "save_project_on_plc",
      "download_connection_file",
    ])
    .describe(
      "PLC diagnostics/maintenance action: " +
        "trace (DataAnalyzer run), file_upload/file_download/file_delete (files on the control), " +
        "code_analysis (static analysis on the project or one source file), " +
        "download_os (install a LasalOS .lbi — control reboots), clear_ram_image, " +
        "save_project_on_plc (backup the running project on the control), download_connection_file (.lcf).",
    ),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  connection: z.string().optional().describe("PLC connection string. Omit to use connection from project's .lss file."),
  config_path: z.string().optional().describe("Absolute path to the DataAnalyzer config file (trace action only)."),
  duration_ms: z
    .number()
    .int()
    .optional()
    .default(5000)
    .describe("Duration in milliseconds to run the trace (trace action only). Default 5000."),
  output_path: z.string().optional().describe("Destination path for the trace output or code analysis result."),
  source_file: z
    .string()
    .optional()
    .describe("Analyze a single source file instead of the whole project (code_analysis action only)."),
  plc_path: z.string().optional().describe("File path on the PLC (for file upload/download/delete)."),
  local_path: z.string().optional().describe("Local file path on the host (for file upload/download)."),
  os_path: z.string().optional().describe("LasalOS update file (.lbi) to install (download_os action only)."),
  connection_file: z
    .string()
    .optional()
    .describe(
      "Optional .lcf connection file path (download_connection_file action only; omit to use the project's active connection file).",
    ),
  timeout_s: z
    .number()
    .int()
    .optional()
    .describe("Timeout override in seconds. Defaults: 120s, or 600s for download_os."),
};

export async function plcDiagnosticsHandler(args: {
  action:
    | "trace"
    | "file_upload"
    | "file_download"
    | "file_delete"
    | "code_analysis"
    | "download_os"
    | "clear_ram_image"
    | "save_project_on_plc"
    | "download_connection_file";
  lcp_path?: string;
  connection?: string;
  config_path?: string;
  duration_ms?: number;
  output_path?: string;
  source_file?: string;
  plc_path?: string;
  local_path?: string;
  os_path?: string;
  connection_file?: string;
  timeout_s?: number;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const id = randomUUID();
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
  const logPath = join(SCRATCH, `diag_${id}.log`);
  const conn = args.connection ?? "";
  const defaultTimeoutS = args.action === "download_os" ? 600 : 120;
  const timeoutMs = (args.timeout_s ?? defaultTimeoutS) * 1000;

  const baseLines = (extraLines: string[]): string =>
    [
      "# -*- coding: utf-8 -*-",
      "import sigmatek.lasal.batch as batch",
      `batch.SetExceptionOnError(True)`,
      `batch.OpenLogfile(${emitPath(logPath)})`,
      `prj = batch.LoadProject(${emitPath(resolved.path)})`,
      ...extraLines,
      "batch.CloseProject(prj)",
    ].join("\n") + "\n";

  return withEngineLock(async () => {
    switch (args.action) {
      case "trace": {
        if (!args.config_path) {
          return {
            content: [{ type: "text" as const, text: "config_path is required for action 'trace'" }],
            isError: true,
          };
        }
        const outPath = args.output_path || join(SCRATCH, `trace_${id}.csv`);
        const durationSec = (args.duration_ms ?? 5000) / 1000.0;

        const script =
          [
            "# -*- coding: utf-8 -*-",
            "import sigmatek.lasal.batch as batch",
            "import time",
            `batch.SetExceptionOnError(True)`,
            `batch.OpenLogfile(${emitPath(logPath)})`,
            `prj = batch.LoadProject(${emitPath(resolved.path)})`,
            `batch.DataAnalyzerLoadConfig(${emitPy27String(args.config_path)})`,
            `batch.DataAnalyzerRun(prj, ${emitPy27String(conn)})`,
            `time.sleep(${durationSec})`,
            "batch.DataAnalyzerStop()",
            `batch.DataAnalyzerSaveData(${emitPy27String(outPath)})`,
            "batch.CloseProject(prj)",
          ].join("\n") + "\n";

        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br, { outputPath: outPath });
      }

      case "file_upload": {
        if (!args.plc_path || !args.local_path) {
          return {
            content: [{ type: "text" as const, text: "plc_path and local_path are required for action 'file_upload'" }],
            isError: true,
          };
        }
        // Upload transfers file from PLC (src) to host (dest)
        const script = baseLines([
          `ok = batch.UploadFile(prj, ${emitPy27String(conn)}, ${emitPy27String(args.plc_path)}, ${emitPy27String(args.local_path)})`,
          `if not ok: raise RuntimeError("UploadFile failed")`,
        ]);

        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br);
      }

      case "file_download": {
        if (!args.plc_path || !args.local_path) {
          return {
            content: [
              { type: "text" as const, text: "plc_path and local_path are required for action 'file_download'" },
            ],
            isError: true,
          };
        }
        // Download transfers file from host (src) to PLC (dest)
        const script = baseLines([
          `ok = batch.DownloadFile(prj, ${emitPy27String(conn)}, ${emitPy27String(args.local_path)}, ${emitPy27String(args.plc_path)})`,
          `if not ok: raise RuntimeError("DownloadFile failed")`,
        ]);

        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br);
      }

      case "file_delete": {
        if (!args.plc_path) {
          return {
            content: [{ type: "text" as const, text: "plc_path is required for action 'file_delete'" }],
            isError: true,
          };
        }
        const script = baseLines([
          `ok = batch.DeleteFileOnPLC(prj, ${emitPy27String(conn)}, ${emitPy27String(args.plc_path)})`,
          `if not ok: raise RuntimeError("DeleteFileOnPLC failed")`,
        ]);

        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br);
      }

      case "code_analysis": {
        const outPath = args.output_path || join(SCRATCH, `analysis_${id}.xml`);
        // CLASS 2 >= 02.04 renamed DoCodeAnalysisOnProjekt -> DoCodeAnalysisOnProject.
        const analysisCall = args.source_file
          ? `ok = batch.DoCodeAnalysisOnFile(prj, ${emitPy27String(args.source_file)}, ${emitPy27String(outPath)})`
          : `ok = batch.DoCodeAnalysisOnProject(prj, ${emitPy27String(outPath)})`;
        const script = baseLines([analysisCall, `if not ok: raise RuntimeError("DoCodeAnalysisOnProject failed")`]);

        const br = await runScript(script, logPath, timeoutMs);
        let summary: unknown = {};
        if (br.ok && existsSync(outPath)) {
          try {
            const rawXml = readFileSync(outPath, "utf-8");
            const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
            const parsed = parser.parse(rawXml);
            summary = parsed;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            summary = { error: `Failed to parse analysis XML: ${msg}`, path: outPath };
          }
        }
        return batchResultToResponse(br, { analysisResult: summary, outputPath: outPath });
      }

      case "download_os": {
        if (!args.os_path) {
          return {
            content: [{ type: "text" as const, text: "os_path is required for action 'download_os'" }],
            isError: true,
          };
        }
        if (!existsSync(args.os_path)) {
          return {
            content: [{ type: "text" as const, text: `OS file not found: ${args.os_path}` }],
            isError: true,
          };
        }
        if (!conn) {
          return {
            content: [
              {
                type: "text" as const,
                text: "connection is required for action 'download_os' (the reboot after install aborts with a lost connection otherwise).",
              },
            ],
            isError: true,
          };
        }
        const script = baseLines([
          `ok = batch.DownloadOS(${emitPy27String(conn)}, ${emitPy27String(args.os_path)})`,
          `if not ok: raise RuntimeError("DownloadOS failed")`,
        ]);

        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br, {
          hints: [
            "The control reboots after the OS install; allow up to several minutes before it is reachable again.",
          ],
        });
      }

      case "clear_ram_image": {
        if (!conn) {
          return {
            content: [{ type: "text" as const, text: "connection is required for action 'clear_ram_image'" }],
            isError: true,
          };
        }
        const script = baseLines([
          `ok = batch.ClearRamImage(${emitPy27String(conn)})`,
          `if not ok: raise RuntimeError("ClearRamImage failed")`,
        ]);

        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br);
      }

      case "save_project_on_plc": {
        const script = baseLines([`batch.SaveProjectOnPLC(prj, ${emitPy27String(conn)})`]);
        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br);
      }

      case "download_connection_file": {
        const script = baseLines([
          args.connection_file
            ? `batch.DownloadConnectionFile(prj, ${emitPy27String(conn)}, ${emitPy27String(args.connection_file)})`
            : `batch.DownloadConnectionFile(prj, ${emitPy27String(conn)})`,
        ]);
        const br = await runScript(script, logPath, timeoutMs);
        return batchResultToResponse(br);
      }

      default:
        return { content: [{ type: "text" as const, text: `Unknown action: ${args.action}` }], isError: true };
    }
  });
}
