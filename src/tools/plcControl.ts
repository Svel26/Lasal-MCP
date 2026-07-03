import { existsSync, readFileSync, mkdirSync, lstatSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { runBatchOps, runScript, emitPy27String, emitPath, BatchResult, buildRawScript } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { parseLcn } from "../utils/lasalXml.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";
import { TIMEOUTS } from "../utils/config.js";
import { preflightPlc, resolveConnection } from "../utils/preflight.js";
import { respond, fail } from "../utils/respond.js";

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
    ...(br.hints?.length ? { hints: br.hints } : {}),
    ...extra,
  };
  return respond(body as any);
}

function isTransientError(errors: string[]): boolean {
  const transientPatterns = [/connect/i, /timeout/i, /offline/i, /socket/i, /1954/i];
  return errors.some(err => transientPatterns.some(p => p.test(err)));
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
  timeout_s: z
    .number()
    .int()
    .optional()
    .describe("Timeout in seconds for compile or download. Omit for default (600s)."),
};

export async function buildProjectHandler(args: {
  action: "compile" | "download";
  lcp_path?: string;
  options?: string;
  connection?: string;
  add_loader_anyway?: boolean;
  timeout_s?: number;
}) {
  return withEngineLock(async () => {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) {
      return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
    }

    if (args.action === "compile") {
      const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.compile;
      const br = runBatchOps(resolved.path, [{ type: "compile", optionName: args.options ?? "RebuildAll" }], timeoutMs);
      return batchResultToResponse(br);
    }

    // download
    const connectionInfo = resolveConnection(resolved.path, args.connection);
    const ipUsed = connectionInfo.ip ?? "";
    const connectionUsed = connectionInfo.connection;

    // Preflight PLC target
    const pf = await preflightPlc(resolved.path, args.connection);
    if (!pf.ok) {
      return respond({
        ok: false,
        preflight: pf,
        connectionUsed,
        ipUsed,
        errors: pf.problems.map(p => p.message),
        hints: pf.problems.map(p => p.fix)
      });
    }

    const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.download;

    let br = runBatchOps(
      resolved.path,
      [{ type: "download", connection: connectionUsed, addLoaderAnyway: args.add_loader_anyway ?? false }],
      timeoutMs
    );

    // Auto-retry transient connection errors once
    if (!br.ok && isTransientError(br.errors)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      br = runBatchOps(
        resolved.path,
        [{ type: "download", connection: connectionUsed, addLoaderAnyway: args.add_loader_anyway ?? false }],
        timeoutMs
      );
      br.hints = [...(br.hints ?? []), "Retried download once due to a transient connection failure."];
    }

    return batchResultToResponse(br, {
      connectionUsed,
      ipUsed,
      postDownloadState: br.postDownloadState,
      lcpPath: resolved.path
    });
  });
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
    if ("error" in resolved) {
      return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
    }

    ensureScratch();
    const id = randomUUID();
    const logPath = join(SCRATCH, `${id}.log`);
    const resultPath = join(SCRATCH, `${id}.state.json`);
    const stepsPath = join(SCRATCH, `${id}.steps`);

    const connectionInfo = resolveConnection(resolved.path, args.connection);
    const ipUsed = connectionInfo.ip ?? "";
    const conn = connectionInfo.connection;

    // Run preflight only if not just querying state
    if (args.action !== "get_state") {
      const pf = await preflightPlc(resolved.path, args.connection);
      if (!pf.ok) {
        return respond({
          ok: false,
          preflight: pf,
          connectionUsed: conn,
          ipUsed,
          errors: pf.problems.map(p => p.message),
          hints: pf.problems.map(p => p.fix)
        });
      }
    }

    if (args.action === "start") {
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

      const script = buildRawScript(resolved.path, bodyLines, logPath, stepsPath, ["start"]);
      let br = runScript(script, logPath, TIMEOUTS.script, ["start"]);

      if (!br.ok && isTransientError(br.errors)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        br = runScript(script, logPath, TIMEOUTS.script, ["start"]);
        br.hints = [...(br.hints ?? []), "Retried start once due to a transient connection failure."];
      }

      let stateData: Record<string, unknown> = {};
      if (existsSync(resultPath)) {
        try { stateData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch {}
      }

      return batchResultToResponse(br, {
        connectionUsed: conn,
        ipUsed,
        postStartState: stateData
      });
    }

    if (args.action === "stop") {
      const bodyLines = [
        `batch.Stop(prj, ${emitPy27String(conn)})`,
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

      const script = buildRawScript(resolved.path, bodyLines, logPath, stepsPath, ["stop"]);
      let br = runScript(script, logPath, TIMEOUTS.script, ["stop"]);

      if (!br.ok && isTransientError(br.errors)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        br = runScript(script, logPath, TIMEOUTS.script, ["stop"]);
        br.hints = [...(br.hints ?? []), "Retried stop once due to a transient connection failure."];
      }

      let stateData: Record<string, unknown> = {};
      if (existsSync(resultPath)) {
        try { stateData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch {}
      }

      return batchResultToResponse(br, {
        connectionUsed: conn,
        ipUsed,
        postStopState: stateData
      });
    }

    // get_state
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

    const script = buildRawScript(resolved.path, bodyLines, logPath, stepsPath, ["get_state"]);
    let br = runScript(script, logPath, TIMEOUTS.script, ["get_state"]);

    if (!br.ok && isTransientError(br.errors)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      br = runScript(script, logPath, TIMEOUTS.script, ["get_state"]);
      br.hints = [...(br.hints ?? []), "Retried get_state once due to a transient connection failure."];
    }

    let stateData: Record<string, unknown> = {};
    if (existsSync(resultPath)) {
      try { stateData = JSON.parse(readFileSync(resultPath, "utf-8")); } catch {}
    }

    return batchResultToResponse(br, {
      connectionUsed: conn,
      ipUsed,
      ...stateData
    });
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
    if ("error" in resolved) {
      return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
    }

    ensureScratch();
    const id = randomUUID();
    const logPath = join(SCRATCH, `${id}.log`);
    const resultPath = join(SCRATCH, `${id}.json`);
    const stepsPath = join(SCRATCH, `${id}.steps`);

    const connectionInfo = resolveConnection(resolved.path, args.connection);
    const ipUsed = connectionInfo.ip ?? "";
    const conn = connectionInfo.connection;

    // Preflight PLC target
    const pf = await preflightPlc(resolved.path, args.connection);
    if (!pf.ok) {
      return respond({
        ok: false,
        preflight: pf,
        connectionUsed: conn,
        ipUsed,
        errors: pf.problems.map(p => p.message),
        hints: pf.problems.map(p => p.fix)
      });
    }

    let script: string;

    if (args.action === "read") {
      if (!args.channels?.length) {
        return fail("channels is required for action 'read'", ["Provide channels to read."]);
      }
      const channelListPy = `[${args.channels.map(emitPy27String).join(", ")}]`;
      const bodyLines = [
        "batch.SetExceptionOnError(False)",
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
        `f = open(${emitPath(resultPath)}, 'w')`,
        "json.dump(result, f)",
        "f.close()"
      ];
      script = buildRawScript(resolved.path, bodyLines, logPath, stepsPath, ["read"]);
    } else {
      if (!args.values?.length) {
        return fail("values is required for action 'write'", ["Provide values to write."]);
      }
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
      const bodyLines = [
        "batch.SetExceptionOnError(False)",
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
        `f = open(${emitPath(resultPath)}, 'w')`,
        "json.dump(result, f)",
        "f.close()"
      ];
      script = buildRawScript(resolved.path, bodyLines, logPath, stepsPath, ["write"]);
    }

    let br = runScript(script, logPath, TIMEOUTS.script, args.action === "read" ? ["read"] : ["write"]);
    if (!br.ok && isTransientError(br.errors)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      br = runScript(script, logPath, TIMEOUTS.script, args.action === "read" ? ["read"] : ["write"]);
      br.hints = [...(br.hints ?? []), `Retried ${args.action} once due to a transient connection failure.`];
    }

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

    // Aggregate channel-level success
    let overallChannelsOk = true;
    const failedChannels: string[] = [];
    if (args.action === "read" && plcData.channels) {
      for (const [name, chInfo] of Object.entries(plcData.channels)) {
        if (!(chInfo as any).ok) {
          overallChannelsOk = false;
          failedChannels.push(name);
        }
      }
    } else if (args.action === "write" && plcData.writes) {
      for (const [name, chInfo] of Object.entries(plcData.writes)) {
        if (!(chInfo as any).ok) {
          overallChannelsOk = false;
          failedChannels.push(name);
        }
      }
    }

    const ok = br.ok && parseError === null && (plcData.ok as boolean) !== false && overallChannelsOk;
    const hints = [...(br.hints ?? [])];
    if (failedChannels.length > 0) {
      hints.push("Some channels failed. Verify the channel casing and spelling using inspect_project.");
    }

    const body: Record<string, unknown> = {
      ok,
      durationMs: br.durationMs,
      ...plcData,
      ...(parseError ? { ok: false, error: `JSON Parse failure: ${parseError}`, raw: rawContent } : {}),
      ...(br.errors.length ? { scriptErrors: br.errors } : {}),
      ...(br.warnings.length ? { scriptWarnings: br.warnings } : {}),
      logPath: br.logPath,
      connectionUsed: conn,
      ipUsed,
      hints,
      ...(failedChannels.length ? { failedChannels } : {})
    };
    return respond(body as any);
  });
}
