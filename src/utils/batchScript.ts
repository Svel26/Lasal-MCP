import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync, execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { CLASS2_EXE, SCRATCH, killClass2 } from "./engine.js";

export interface BatchResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
  errors: string[];
  warnings: string[];
  logTail: string[];
  durationMs: number;
  command: string;
}

export interface BatchOp {
  type:
    | "create_network"
    | "delete_network"
    | "rename_network"
    | "duplicate_network"
    | "add_object"
    | "remove_object"
    | "rename_object"
    | "change_object_class"
    | "create_connection"
    | "delete_connection"
    | "set_init_value"
    | "delete_class"
    | "compile"
    | "download"
    | "set_task_order"
    | "set_task_time"
    | "set_task_cpu_core"
    | "set_multi_cpu_core"
    | "set_visualized_flag"
    | "set_comment_network"
    | "set_comment_object"
    | "set_network_options"
    | "reset_network_options"
    | "move_network_to_folder"
    | "set_parameter_value"
    | "save";
  // per-op params (typed loosely, validated by the tool layer)
  [key: string]: unknown;
}

function ensureScratch() {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
}



export function emitPy27String(s: string): string {
  // Produce a Python 2.7 string expression encoded with mbcs to match C++ ATL::CStringT expectations
  return `u"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}".encode('mbcs')`;
}

export function emitPath(p: string): string {
  return emitPy27String(p);
}

function emitPy27StringList(arr: string[]): string {
  return `[${arr.map(emitPy27String).join(", ")}]`;
}

/** Build the body of a batch.py Python 2.7 script from a list of operations. */
export function buildBatchScript(lcpPath: string, ops: BatchOp[], logPath: string): string {
  const lines: string[] = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    "batch.SetExceptionOnError(True)",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    `prj = batch.LoadProject(${emitPath(lcpPath)})`,
    "",
  ];

  for (const op of ops) {
    switch (op.type) {
      case "create_network":
        lines.push(`batch.CreateNetwork(prj, ${emitPy27String(op.name as string)})`);
        break;
      case "delete_network":
        lines.push(
          `batch.DeleteNetwork(prj, ${emitPy27String(op.name as string)}, ${op.deleteConnections ? "True" : "False"}, False)`
        );
        break;
      case "rename_network":
        lines.push(
          `batch.RenameNetwork(prj, ${emitPy27String(op.oldName as string)}, ${emitPy27String(op.newName as string)})`
        );
        break;
      case "duplicate_network":
        lines.push(
          `batch.DuplicateNetwork(prj, ${emitPy27String(op.name as string)}, ${emitPy27String(op.newName as string)})`
        );
        break;
      case "add_object":
        lines.push(
          `batch.CreateObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.className as string)}, ${emitPy27String(op.objectName as string)}, ${op.x ?? 0}, ${op.y ?? 0}, ${op.visualized ? "True" : "False"})`
        );
        break;
      case "remove_object":
        lines.push(
          `batch.DeleteObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${op.deleteConnections !== false ? "True" : "False"})`
        );
        break;
      case "rename_object":
        lines.push(
          `batch.RenameObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.oldName as string)}, ${emitPy27String(op.newName as string)})`
        );
        break;
      case "change_object_class":
        lines.push(
          `batch.ChangeClass(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.className as string)}, False)`
        );
        break;
      case "create_connection": {
        const net = op.network as string | undefined;
        if (net) {
          lines.push(
            `batch.CreateConnection(prj, ${emitPy27String(net)}, ${emitPy27String(op.fromObject as string)}, ${emitPy27String(op.fromClient as string)}, ${emitPy27String(net)}, ${emitPy27String(op.toObject as string)}, ${emitPy27String(op.toServer as string)})`
          );
        } else {
          lines.push(
            `batch.CreateConnection2(prj, ${emitPy27String(op.fromObject as string)}, ${emitPy27String(op.fromClient as string)}, ${emitPy27String(op.toObject as string)}, ${emitPy27String(op.toServer as string)})`
          );
        }
        break;
      }
      case "delete_connection": {
        const net = op.network as string | undefined;
        if (net) {
          lines.push(
            `batch.DeleteConnection(prj, ${emitPy27String(net)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.clientName as string)})`
          );
        } else {
          lines.push(
            `batch.DeleteConnection2(prj, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.clientName as string)})`
          );
        }
        break;
      }
      case "set_init_value": {
        const net = op.network as string | undefined;
        if (net) {
          lines.push(
            `batch.SetInitValue(prj, ${emitPy27String(net)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.channelName as string)}, ${emitPy27String(op.value as string)})`
          );
        } else {
          lines.push(
            `batch.SetInitValue2(prj, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.channelName as string)}, ${emitPy27String(op.value as string)})`
          );
        }
        break;
      }
      case "delete_class":
        lines.push(
          `batch.DeleteClass(prj, ${emitPy27String(op.className as string)}, ${op.force ? "True" : "False"})`
        );
        break;

      case "compile": {
        const optName = (op.optionName as string | undefined) ?? "RebuildAll";
        lines.push(`batch.Compile(prj, batch.CompileOptions.${optName})`);
        break;
      }

      case "download":
        lines.push(
          `batch.Download(prj, ${emitPy27String((op.connection as string | undefined) ?? "")}, ${op.addLoaderAnyway ? "True" : "False"}, False)`
        );
        break;

      case "set_task_order":
        lines.push(
          `batch.SetTaskOrder(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.task as string)}, ${emitPy27String(String(op.position))})`
        );
        break;

      case "set_task_time":
        lines.push(
          `batch.SetTaskTime(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.task as string)}, ${emitPy27String(op.time as string)})`
        );
        break;

      case "set_task_cpu_core":
        lines.push(
          `batch.SetTaskCPUCore(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.task as string)}, ${Number(op.core)})`
        );
        break;

      case "set_multi_cpu_core":
        lines.push(`batch.SetMultiCPUCore(prj, ${op.multiCore ? "True" : "False"})`);
        break;

      case "set_visualized_flag":
        lines.push(
          `batch.SetVisualizedFlag(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${op.isVisualized ? "True" : "False"})`
        );
        break;

      case "set_comment_network":
        lines.push(
          `batch.SetCommentNetwork(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.comment as string)})`
        );
        break;

      case "set_comment_object":
        lines.push(
          `batch.SetCommentObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.comment as string)})`
        );
        break;

      case "set_network_options":
        lines.push(
          `batch.SetNetworkOptions(prj, ${emitPy27String(op.network as string)}, ${emitPy27StringList(op.optionNames as string[])}, ${op.resetAllOthers ? "True" : "False"})`
        );
        break;

      case "reset_network_options":
        lines.push(
          `batch.ResetNetworkOptions(prj, ${emitPy27String(op.network as string)}, ${emitPy27StringList(op.optionNames as string[])})`
        );
        break;

      case "move_network_to_folder":
        lines.push(
          `batch.MoveNetworkToFolder(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.folder as string)})`
        );
        break;

      case "set_parameter_value":
        lines.push(
          `batch.SetParameterValue(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.parameterName as string)}, ${emitPy27String(op.value as string)})`
        );
        break;

      case "save":
        // explicit save
        break;
    }
  }

  lines.push("", "batch.Save(prj)", "batch.CloseProject(prj)");
  return lines.join("\n") + "\n";
}

/** Run an arbitrary pre-built Python 2.7 script against Lasal2.exe without killing the IDE first. */
export function runScript(
  script: string,
  logPath: string,
  timeoutMs = 120_000
): BatchResult {
  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `${id}.py`);
  writeFileSync(scriptPath, script, "utf-8");

  const command = `"${CLASS2_EXE}" /script:"${scriptPath}"`;
  const start = Date.now();
  let exitCode = 0;

  const stderrLines: string[] = [];
  try {
    execFileSync(CLASS2_EXE, [`/script:${scriptPath}`], {
      timeout: timeoutMs,
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (e: any) {
    exitCode = e.status ?? 1;
    const stderr: string = (e.stderr ?? "").toString("utf-8").trim();
    if (stderr) {
      for (const line of stderr.split("\n")) {
        const t = line.trim();
        if (t) stderrLines.push(t);
      }
    }
    killClass2();
  }

  const durationMs = Date.now() - start;
  const errors: string[] = [];
  const warnings: string[] = [];
  const logTail: string[] = [];

  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf-8");
    const lines = log.split("\n");
    for (const line of lines) {
      if (line.includes("(ERROR)") || line.includes("(FATAL)")) errors.push(line.trim());
      else if (line.includes("(WARN)")) warnings.push(line.trim());
    }
    if (exitCode !== 0 || errors.length > 0) {
      logTail.push(...lines.filter(l => l.trim()).slice(-15).map(l => l.trim()));
    }
  }

  errors.push(...stderrLines);

  if (exitCode !== 0 && errors.length === 0) {
    errors.push(`Lasal2.exe exited with code ${exitCode}`);
  }

  return { ok: exitCode === 0 && errors.length === 0, exitCode, logPath, errors, warnings, logTail, durationMs, command };
}

export function runBatchOps(
  lcpPath: string,
  ops: BatchOp[],
  timeoutMs = 120_000
): BatchResult {
  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `${id}.py`);
  const logPath = join(SCRATCH, `${id}.log`);

  const script = buildBatchScript(lcpPath, ops, logPath);
  writeFileSync(scriptPath, script, "utf-8");

  const command = `"${CLASS2_EXE}" /script:"${scriptPath}"`;
  const start = Date.now();
  let exitCode = 0;

  killClass2();

  const stderrLines: string[] = [];
  try {
    execFileSync(CLASS2_EXE, [`/script:${scriptPath}`], {
      timeout: timeoutMs,
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (e: any) {
    exitCode = e.status ?? 1;
    const stderr: string = (e.stderr ?? "").toString("utf-8").trim();
    if (stderr) {
      for (const line of stderr.split("\n")) {
        const t = line.trim();
        if (t) stderrLines.push(t);
      }
    }
    killClass2();
  }

  const durationMs = Date.now() - start;
  const errors: string[] = [];
  const warnings: string[] = [];
  const logTail: string[] = [];

  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf-8");
    const lines = log.split("\n");
    for (const line of lines) {
      if (line.includes("(ERROR)") || line.includes("(FATAL)")) errors.push(line.trim());
      else if (line.includes("(WARN)")) warnings.push(line.trim());
    }
    if (exitCode !== 0 || errors.length > 0) {
      logTail.push(...lines.filter(l => l.trim()).slice(-15).map(l => l.trim()));
    }
  }

  errors.push(...stderrLines);

  if (exitCode !== 0 && errors.length === 0) {
    errors.push(`Lasal2.exe exited with code ${exitCode}`);
  }

  return {
    ok: exitCode === 0 && errors.length === 0,
    exitCode,
    logPath,
    errors,
    warnings,
    logTail,
    durationMs,
    command,
  };
}
