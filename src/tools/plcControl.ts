import { existsSync, readFileSync, mkdirSync, lstatSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { runBatchOps, runScript, emitPy27String, emitPath, BatchResult } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { parseLcn } from "../utils/lasalXml.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";

function ensureScratch() {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
}

// Recursively find all project files
function getProjectFiles(dir: string, files: string[] = []): string[] {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (lstatSync(p).isDirectory()) {
        getProjectFiles(p, files);
      } else {
        files.push(p);
      }
    }
  } catch {}
  return files;
}

// Resolve Structured Text channel type for coercion
function resolveChannelType(projDir: string, objectName: string, channelName: string): string | null {
  const files = getProjectFiles(projDir);
  const lcnFiles = files.filter(f => f.endsWith(".lcn"));
  const stFiles = files.filter(f => f.endsWith(".st"));

  let className: string | null = null;
  for (const lcnFile of lcnFiles) {
    try {
      const info = parseLcn(lcnFile);
      const obj = info.objects.find(o => o.name === objectName);
      if (obj) {
        className = obj.className;
        break;
      }
    } catch {}
  }
  if (!className) return null;

  const stFile = stFiles.find(f => {
    const base = f.substring(f.lastIndexOf("\\") + 1, f.lastIndexOf("."));
    return base.toLowerCase() === className?.toLowerCase();
  });
  if (!stFile) return null;

  try {
    const stContent = readFileSync(stFile, "utf-8");
    const re = new RegExp(`//\\s*${channelName}\\s*:\\s*(\\w+)`, "i");
    const m = stContent.match(re);
    if (m) {
      return m[1].toUpperCase();
    }
  } catch {}
  return null;
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

// ─── build_project ────────────────────────────────────────────────────────────

export const buildProjectSchema = {
  action: z
    .enum(["compile", "download"])
    .describe("'compile' builds the project; 'download' transfers it to the PLC."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  options: z
    .enum(["RebuildAll", "BuildChanges", "UserClassesOnly", "NoDebugInfo"])
    .optional()
    .default("RebuildAll")
    .describe("Compile mode (compile only). RebuildAll is safest; BuildChanges is faster for incremental work."),
  connection: z
    .string()
    .optional()
    .describe(
      "Connection string (e.g. 'TCPIP:192.168.1.100') or address-book name (download only). Omit to use the connection saved in the .lss file."
    ),
  add_loader_anyway: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force loader download even if the target OS already has a compatible loader (download only)."),
};

export async function buildProjectHandler(args: {
  action: "compile" | "download";
  lcp_path?: string;
  options?: string;
  connection?: string;
  add_loader_anyway?: boolean;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  if (args.action === "compile") {
    const br = runBatchOps(resolved.path, [{ type: "compile", optionName: args.options ?? "RebuildAll" }]);
    return batchResultToResponse(br);
  }

  const connection = args.connection ?? "";
  const br = runBatchOps(
    resolved.path,
    [{ type: "download", connection, addLoaderAnyway: args.add_loader_anyway ?? false }],
    300_000
  );
  return batchResultToResponse(br, { connection: connection || "(from .lss file)", lcpPath: resolved.path });
}

// ─── control_plc ─────────────────────────────────────────────────────────────

export const controlPlcSchema = {
  action: z
    .enum(["start", "stop", "get_state"])
    .describe("'start' runs the PLC project; 'stop' halts it; 'get_state' queries its current state."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z
    .string()
    .optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
};

export async function controlPlcHandler(args: {
  action: "start" | "stop" | "get_state";
  lcp_path?: string;
  connection?: string;
}) {
  return withEngineLock(async () => {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const conn = args.connection ?? "";

  if (args.action === "start") {
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

  if (args.action === "stop") {
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

  // get_state
  const resultPath = join(SCRATCH, `${id}.json`);
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
  });
}

// ─── plc_values ──────────────────────────────────────────────────────────────

export const plcValuesSchema = {
  action: z
    .enum(["read", "write"])
    .describe("'read' fetches live channel values; 'write' pushes new values."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  connection: z
    .string()
    .optional()
    .describe("Connection string or address-book name. Omit to use the project's saved connection."),
  channels: z
    .array(z.string())
    .optional()
    .describe("Channel paths to read, each in 'ObjectName.ChannelName' format (read only)."),
  values: z
    .array(
      z.object({
        channel: z.string().describe("Channel path in 'ObjectName.ChannelName' format."),
        value: z.string().describe("New value as string."),
      })
    )
    .optional()
    .describe("Channel/value pairs to write (write only)."),
};

export async function plcValuesHandler(args: {
  action: "read" | "write";
  lcp_path?: string;
  connection?: string;
  channels?: string[];
  values?: { channel: string; value: string }[];
}) {
  return withEngineLock(async () => {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const resultPath = join(SCRATCH, `${id}.json`);
  const conn = args.connection ?? "";

  let script: string;

  if (args.action === "read") {
    if (!args.channels?.length) {
      return { content: [{ type: "text" as const, text: "channels is required for action 'read'" }], isError: true };
    }
    const channelListPy = `[${args.channels.map(emitPy27String).join(", ")}]`;
    script = [
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
  } else {
    const writeOpsList: string[] = [];
    const projDir = resolved.path.substring(0, resolved.path.lastIndexOf("\\"));
    for (const item of args.values ?? []) {
      const ch = item.channel;
      const parts = ch.split(".");
      let pyVal = `${emitPy27String(item.value)}`;
      if (parts.length === 2) {
        const type = resolveChannelType(projDir, parts[0], parts[1]);
        if (type) {
          if (type === "BOOL") {
            const isTrue = item.value.toLowerCase() === "true" || item.value === "1";
            pyVal = isTrue ? "True" : "False";
          } else if (["REAL", "LREAL"].includes(type)) {
            if (!isNaN(Number(item.value))) {
              pyVal = item.value;
            }
          } else if (["DINT", "INT", "SINT", "UDINT", "UINT", "USINT"].includes(type)) {
            if (/^-?\d+$/.test(item.value)) {
              pyVal = item.value;
            }
          }
        }
      }
      writeOpsList.push(`(${emitPy27String(ch)}, ${pyVal})`);
    }
    const writeOpsPy = `[${writeOpsList.join(", ")}]`;
    script = [
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
  }

  const br = runScript(script, logPath);
  let plcData: Record<string, unknown> = {};
  let parseError: string | null = null;
  let rawContent = "";
  if (existsSync(resultPath)) {
    rawContent = readFileSync(resultPath, "utf-8");
    try {
      plcData = JSON.parse(rawContent);
    } catch (e: any) {
      parseError = e.message;
    }
  }

  const ok = br.ok && parseError === null && (plcData.ok as boolean) !== false;
  const body: Record<string, unknown> = {
    ok,
    durationMs: br.durationMs,
    ...plcData,
    ...(parseError ? { ok: false, error: `JSON Parse failure: ${parseError}`, raw: rawContent } : {}),
    ...(br.errors.length ? { scriptErrors: br.errors } : {}),
    ...(br.warnings.length ? { scriptWarnings: br.warnings } : {}),
    logPath: br.logPath,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(ok ? {} : { isError: true }),
  };
  });
}
