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
  action: z.enum(["trace", "file_upload", "file_download", "file_delete", "code_analysis"])
    .describe("PLC diagnostics/maintenance action to perform."),
  lcp_path: z.string().optional().describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  connection: z.string().optional().describe("PLC connection string. Omit to use connection from project's .lss file."),
  config_path: z.string().optional().describe("Absolute path to the DataAnalyzer config file (trace action only)."),
  duration_ms: z.number().int().optional().default(5000).describe("Duration in milliseconds to run the trace (trace action only). Default 5000."),
  output_path: z.string().optional().describe("Destination path for the trace output or code analysis result."),
  plc_path: z.string().optional().describe("File path on the PLC (for file upload/download/delete)."),
  local_path: z.string().optional().describe("Local file path on the host (for file upload/download)."),
};

export async function plcDiagnosticsHandler(args: {
  action: "trace" | "file_upload" | "file_download" | "file_delete" | "code_analysis";
  lcp_path?: string;
  connection?: string;
  config_path?: string;
  duration_ms?: number;
  output_path?: string;
  plc_path?: string;
  local_path?: string;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const id = randomUUID();
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
  const logPath = join(SCRATCH, `diag_${id}.log`);
  const conn = args.connection ?? "";

  return withEngineLock(async () => {
    switch (args.action) {
      case "trace": {
        if (!args.config_path) {
          return { content: [{ type: "text" as const, text: "config_path is required for action 'trace'" }], isError: true };
        }
        const outPath = args.output_path || join(SCRATCH, `trace_${id}.csv`);
        const durationSec = (args.duration_ms ?? 5000) / 1000.0;

        const script = [
          "# -*- coding: utf-8 -*-",
          "import sigmatek.lasal.batch as batch",
          "import time",
          `batch.OpenLogfile(${emitPath(logPath)})`,
          `prj = batch.LoadProject(${emitPath(resolved.path)})`,
          `batch.DataAnalyzerLoadConfig(${emitPy27String(args.config_path)})`,
          `batch.DataAnalyzerRun(prj, ${emitPy27String(conn)})`,
          `time.sleep(${durationSec})`,
          "batch.DataAnalyzerStop()",
          `batch.DataAnalyzerSaveData(${emitPy27String(outPath)})`,
          "batch.CloseProject(prj)",
        ].join("\n") + "\n";

        const br = await runScript(script, logPath);
        return batchResultToResponse(br, { outputPath: outPath });
      }

      case "file_upload": {
        if (!args.plc_path || !args.local_path) {
          return { content: [{ type: "text" as const, text: "plc_path and local_path are required for action 'file_upload'" }], isError: true };
        }
        // Upload transfers file from PLC (src) to host (dest)
        const script = [
          "# -*- coding: utf-8 -*-",
          "import sigmatek.lasal.batch as batch",
          `batch.OpenLogfile(${emitPath(logPath)})`,
          `prj = batch.LoadProject(${emitPath(resolved.path)})`,
          `ok = batch.UploadFile(prj, ${emitPy27String(conn)}, ${emitPy27String(args.plc_path)}, ${emitPy27String(args.local_path)})`,
          "batch.CloseProject(prj)",
          `if not ok: raise RuntimeError("UploadFile failed")`,
        ].join("\n") + "\n";

        const br = await runScript(script, logPath);
        return batchResultToResponse(br);
      }

      case "file_download": {
        if (!args.plc_path || !args.local_path) {
          return { content: [{ type: "text" as const, text: "plc_path and local_path are required for action 'file_download'" }], isError: true };
        }
        // Download transfers file from host (src) to PLC (dest)
        const script = [
          "# -*- coding: utf-8 -*-",
          "import sigmatek.lasal.batch as batch",
          `batch.OpenLogfile(${emitPath(logPath)})`,
          `prj = batch.LoadProject(${emitPath(resolved.path)})`,
          `ok = batch.DownloadFile(prj, ${emitPy27String(conn)}, ${emitPy27String(args.local_path)}, ${emitPy27String(args.plc_path)})`,
          "batch.CloseProject(prj)",
          `if not ok: raise RuntimeError("DownloadFile failed")`,
        ].join("\n") + "\n";

        const br = await runScript(script, logPath);
        return batchResultToResponse(br);
      }

      case "file_delete": {
        if (!args.plc_path) {
          return { content: [{ type: "text" as const, text: "plc_path is required for action 'file_delete'" }], isError: true };
        }
        const script = [
          "# -*- coding: utf-8 -*-",
          "import sigmatek.lasal.batch as batch",
          `batch.OpenLogfile(${emitPath(logPath)})`,
          `prj = batch.LoadProject(${emitPath(resolved.path)})`,
          `ok = batch.DeleteFileOnPLC(prj, ${emitPy27String(conn)}, ${emitPy27String(args.plc_path)})`,
          "batch.CloseProject(prj)",
          `if not ok: raise RuntimeError("DeleteFileOnPLC failed")`,
        ].join("\n") + "\n";

        const br = await runScript(script, logPath);
        return batchResultToResponse(br);
      }

      case "code_analysis": {
        const outPath = args.output_path || join(SCRATCH, `analysis_${id}.xml`);
        const script = [
          "# -*- coding: utf-8 -*-",
          "import sigmatek.lasal.batch as batch",
          `batch.OpenLogfile(${emitPath(logPath)})`,
          `prj = batch.LoadProject(${emitPath(resolved.path)})`,
          `ok = batch.DoCodeAnalysisOnProjekt(prj, ${emitPy27String(outPath)})`,
          "batch.CloseProject(prj)",
          `if not ok: raise RuntimeError("DoCodeAnalysisOnProjekt failed")`,
        ].join("\n") + "\n";

        const br = await runScript(script, logPath);
        let summary: any = {};
        if (br.ok && existsSync(outPath)) {
          try {
            const rawXml = readFileSync(outPath, "utf-8");
            const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
            const parsed = parser.parse(rawXml);
            summary = parsed;
          } catch (e: any) {
            summary = { error: `Failed to parse analysis XML: ${e.message}`, path: outPath };
          }
        }
        return batchResultToResponse(br, { analysisResult: summary });
      }

      default:
        return { content: [{ type: "text" as const, text: `Unknown action: ${args.action}` }], isError: true };
    }
  });
}
