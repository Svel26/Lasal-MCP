import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { z } from "zod";
import { runBatchOps, runScript, emitPy27String, emitPath, BatchResult } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";

const SCRATCH = join(tmpdir(), "lasal-mcp");

function ensureScratch() {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
}

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

// ─── compile_project ─────────────────────────────────────────────────────────

export const compileProjSchema = {
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  options: z.enum(["RebuildAll", "BuildChanges", "UserClassesOnly", "NoDebugInfo"])
    .optional()
    .default("RebuildAll")
    .describe("Compile mode. RebuildAll is safest. BuildChanges is faster for incremental work."),
};

export async function compileProjHandler(args: { lcp_path?: string; options?: string }) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  const br = runBatchOps(resolved.path, [{ type: "compile", optionName: args.options ?? "RebuildAll" }]);
  return batchResultToResponse(br);
}

// ─── download_project ────────────────────────────────────────────────────────

export const downloadProjSchema = {
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z.string().optional()
    .describe("Connection string (e.g. 'TCPIP:192.168.1.100') or address-book name. Omit to use the connection saved in the project (.lss file)."),
  add_loader_anyway: z.boolean().optional().default(false)
    .describe("Force loader download even if the target OS already has a compatible loader."),
};

export async function downloadProjHandler(args: {
  lcp_path?: string;
  connection?: string;
  add_loader_anyway?: boolean;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  const connection = args.connection ?? "";
  const br = runBatchOps(resolved.path, [{
    type: "download",
    connection,
    addLoaderAnyway: args.add_loader_anyway ?? false,
  }], 300_000);
  return batchResultToResponse(br, { connection: connection || "(from .lss file)", lcpPath: resolved.path });
}

// ─── get_plc_state ───────────────────────────────────────────────────────────

export const getPlcStateSchema = {
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z.string().optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
};

export async function getPlcStateHandler(args: { lcp_path?: string; connection?: string }) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const resultPath = join(SCRATCH, `${id}.json`);
  const conn = args.connection ?? "";

  const script = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    "import json",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    `prj = batch.LoadProject(${emitPath(resolved.path)})`,
    `state = batch.GetPlcState(prj, ${emitPy27String(conn)})`,
    "state_map = {}",
    "for attr_name in dir(batch.PLCStates):",
    "    if not attr_name.startswith('_'):",
    "        try:",
    "            state_map[int(getattr(batch.PLCStates, attr_name))] = attr_name",
    "        except:",
    "            pass",
    "state_int = int(state)",
    "state_name = state_map.get(state_int, 'Unknown(%d)' % state_int)",
    "result = {'stateValue': state_int, 'stateName': state_name}",
    `f = open(${emitPath(resultPath)}, 'w')`,
    "json.dump(result, f)",
    "f.close()",
    "batch.CloseProject(prj)",
  ].join("\n") + "\n";

  const br = runScript(script, logPath);

  let stateData: Record<string, unknown> = {};
  if (existsSync(resultPath)) {
    try { stateData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch { /* log parse failure silently */ }
  }

  return batchResultToResponse(br, stateData);
}

// ─── read_plc_values ─────────────────────────────────────────────────────────

export const readPlcValuesSchema = {
  channels: z.array(z.string())
    .describe("List of channel paths to read, each in 'ObjectName.ChannelName' format."),
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z.string().optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
};

export async function readPlcValuesHandler(args: {
  channels: string[];
  lcp_path?: string;
  connection?: string;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const resultPath = join(SCRATCH, `${id}.json`);
  const conn = args.connection ?? "";

  const channelListPy = `[${args.channels.map(emitPy27String).join(", ")}]`;

  const script = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    "import json",
    "batch.SetExceptionOnError(False)",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    `prj = batch.LoadProject(${emitPath(resolved.path)})`,
    `conn_ok = batch.OpenPlcConnection(prj, ${emitPy27String(conn)})`,
    "if conn_ok:",
    `    channels = ${channelListPy}`,
    "    results = {}",
    "    for ch in channels:",
    "        dic = {}",
    "        ok = batch.ReadPlcValue(ch, dic)",
    "        data = {}",
    "        for k, v in dic.items():",
    "            data[str(k)] = str(v)",
    "        results[ch] = {'ok': bool(ok), 'data': data}",
    "    batch.ClosePlcConnection()",
    "    result = {'ok': True, 'channels': results}",
    "else:",
    "    result = {'ok': False, 'error': 'Failed to open PLC connection — check connection string and PLC state'}",
    "batch.CloseProject(prj)",
    `f = open(${emitPath(resultPath)}, 'w')`,
    "json.dump(result, f)",
    "f.close()",
  ].join("\n") + "\n";

  const br = runScript(script, logPath);

  let plcData: Record<string, unknown> = {};
  if (existsSync(resultPath)) {
    try { plcData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch { /* ignore */ }
  }

  const ok = br.ok && (plcData.ok as boolean) !== false;
  const body: Record<string, unknown> = {
    ok,
    durationMs: br.durationMs,
    ...plcData,
    ...(br.errors.length ? { scriptErrors: br.errors } : {}),
    ...(br.warnings.length ? { scriptWarnings: br.warnings } : {}),
    logPath: br.logPath,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(ok ? {} : { isError: true }),
  };
}

// ─── start_plc ───────────────────────────────────────────────────────────────

export const startPlcSchema = {
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z.string().optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
};

export async function startPlcHandler(args: { lcp_path?: string; connection?: string }) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const conn = args.connection ?? "";

  const script = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    `prj = batch.LoadProject(${emitPath(resolved.path)})`,
    `batch.Start(prj, ${emitPy27String(conn)})`,
    "batch.CloseProject(prj)",
  ].join("\n") + "\n";

  const br = runScript(script, logPath);
  return batchResultToResponse(br, { connection: conn || "(from .lss file)" });
}

// ─── stop_plc ────────────────────────────────────────────────────────────────

export const stopPlcSchema = {
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z.string().optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
};

export async function stopPlcHandler(args: { lcp_path?: string; connection?: string }) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const conn = args.connection ?? "";

  const script = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    `prj = batch.LoadProject(${emitPath(resolved.path)})`,
    `batch.Stop(prj, ${emitPy27String(conn)})`,
    "batch.CloseProject(prj)",
  ].join("\n") + "\n";

  const br = runScript(script, logPath);
  return batchResultToResponse(br, { connection: conn || "(from .lss file)" });
}

// ─── write_plc_values ────────────────────────────────────────────────────────

export const writePlcValuesSchema = {
  values: z.array(z.object({
    channel: z.string().describe("Channel path in 'ObjectName.ChannelName' format."),
    value: z.string().describe("New value as string."),
  })).describe("List of channel/value pairs to write."),
  lcp_path: z.string().optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z.string().optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
};

export async function writePlcValuesHandler(args: {
  values: { channel: string; value: string }[];
  lcp_path?: string;
  connection?: string;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const resultPath = join(SCRATCH, `${id}.json`);
  const conn = args.connection ?? "";

  const writeOpsPy = `[${args.values.map(v => `(${emitPy27String(v.channel)}, ${emitPy27String(v.value)})`).join(", ")}]`;

  const script = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    "import json",
    "batch.SetExceptionOnError(False)",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    `prj = batch.LoadProject(${emitPath(resolved.path)})`,
    `conn_ok = batch.OpenPlcConnection(prj, ${emitPy27String(conn)})`,
    "if conn_ok:",
    `    write_ops = ${writeOpsPy}`,
    "    results = {}",
    "    for ch, val in write_ops:",
    "        ok = batch.WritePlcValue(ch, val)",
    "        results[ch] = {'ok': bool(ok)}",
    "    batch.ClosePlcConnection()",
    "    result = {'ok': True, 'writes': results}",
    "else:",
    "    result = {'ok': False, 'error': 'Failed to open PLC connection — check connection string and PLC state'}",
    "batch.CloseProject(prj)",
    `f = open(${emitPath(resultPath)}, 'w')`,
    "json.dump(result, f)",
    "f.close()",
  ].join("\n") + "\n";

  const br = runScript(script, logPath);

  let plcData: Record<string, unknown> = {};
  if (existsSync(resultPath)) {
    try { plcData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch { /* ignore */ }
  }

  const ok = br.ok && (plcData.ok as boolean) !== false;
  const body: Record<string, unknown> = {
    ok,
    durationMs: br.durationMs,
    ...plcData,
    ...(br.errors.length ? { scriptErrors: br.errors } : {}),
    ...(br.warnings.length ? { scriptWarnings: br.warnings } : {}),
    logPath: br.logPath,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(ok ? {} : { isError: true }),
  };
}
