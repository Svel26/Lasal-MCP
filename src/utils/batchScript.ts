import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { CLASS2_EXE, SCRATCH, killClass2 } from "./engine.js";
import { runEngineScript, type StepOutcome } from "./scriptRunner.js";
import { ensureScratch } from "../core/scratch.js";

export interface BatchResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
  errors: string[];
  warnings: string[];
  logTail: string[];
  durationMs: number;
  command: string;
  steps?: StepOutcome[];
  timedOut?: boolean;
  hints?: string[];
  postDownloadState?: Record<string, unknown>;
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
  [key: string]: unknown;
}


export function validateMbcsEncodable(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(
        `String contains character '${s[i]}' (U+${code.toString(16).padStart(4, "0")}) at position ${i} ` +
        `which is not representable in mbcs/latin1. Path or value: "${s}"`,
      );
    }
  }
}

export function emitPy27String(s: string): string {
  validateMbcsEncodable(s);
  return `u"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}".encode('mbcs')`;
}

export function emitPath(p: string): string {
  return emitPy27String(p);
}

function emitPy27StringList(arr: string[]): string {
  return `[${arr.map(emitPy27String).join(", ")}]`;
}

/** Build the body of a batch.py Python 2.7 script from a list of operations. */
export function buildBatchScript(
  lcpPath: string,
  ops: BatchOp[],
  logPath: string,
  stepsPath: string
): { script: string; expectedSteps: string[] } {
  const lines: string[] = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    "import sys",
    "import traceback",
    "batch.SetExceptionOnError(True)",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    "try:",
    `    prj = batch.LoadProject(${emitPath(lcpPath)})`,
    "",
  ];

  const expectedSteps: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op) continue;
    const label = `${i}_${op.type}`;
    expectedSteps.push(label);

    const opLines: string[] = [];
    switch (op.type) {
      case "create_network":
        opLines.push(`batch.CreateNetwork(prj, ${emitPy27String(op.name as string)})`);
        break;
      case "delete_network":
        opLines.push(
          `batch.DeleteNetwork(prj, ${emitPy27String(op.name as string)}, ${op.deleteConnections ? "True" : "False"}, False)`
        );
        break;
      case "rename_network":
        opLines.push(
          `batch.RenameNetwork(prj, ${emitPy27String(op.oldName as string)}, ${emitPy27String(op.newName as string)})`
        );
        break;
      case "duplicate_network":
        opLines.push(
          `batch.DuplicateNetwork(prj, ${emitPy27String(op.name as string)}, ${emitPy27String(op.newName as string)})`
        );
        break;
      case "add_object":
        opLines.push(
          `batch.CreateObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.className as string)}, ${emitPy27String(op.objectName as string)}, ${op.x ?? 0}, ${op.y ?? 0}, ${op.visualized ? "True" : "False"})`
        );
        break;
      case "remove_object":
        opLines.push(
          `batch.DeleteObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${op.deleteConnections !== false ? "True" : "False"})`
        );
        break;
      case "rename_object":
        opLines.push(
          `batch.RenameObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.oldName as string)}, ${emitPy27String(op.newName as string)})`
        );
        break;
      case "change_object_class":
        opLines.push(
          `batch.ChangeClass(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.className as string)}, False)`
        );
        break;
      case "create_connection": {
        const net = op.network as string | undefined;
        if (net) {
          opLines.push(
            `batch.CreateConnection(prj, ${emitPy27String(net)}, ${emitPy27String(op.fromObject as string)}, ${emitPy27String(op.fromClient as string)}, ${emitPy27String(net)}, ${emitPy27String(op.toObject as string)}, ${emitPy27String(op.toServer as string)})`
          );
        } else {
          opLines.push(
            `batch.CreateConnection2(prj, ${emitPy27String(op.fromObject as string)}, ${emitPy27String(op.fromClient as string)}, ${emitPy27String(op.toObject as string)}, ${emitPy27String(op.toServer as string)})`
          );
        }
        break;
      }
      case "delete_connection": {
        const net = op.network as string | undefined;
        if (net) {
          opLines.push(
            `batch.DeleteConnection(prj, ${emitPy27String(net)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.clientName as string)})`
          );
        } else {
          opLines.push(
            `batch.DeleteConnection2(prj, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.clientName as string)})`
          );
        }
        break;
      }
      case "set_init_value": {
        const net = op.network as string | undefined;
        if (net) {
          opLines.push(
            `batch.SetInitValue(prj, ${emitPy27String(net)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.channelName as string)}, ${emitPy27String(op.value as string)})`
          );
        } else {
          opLines.push(
            `batch.SetInitValue2(prj, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.channelName as string)}, ${emitPy27String(op.value as string)})`
          );
        }
        break;
      }
      case "delete_class":
        opLines.push(
          `batch.DeleteClass(prj, ${emitPy27String(op.className as string)}, ${op.force ? "True" : "False"})`
        );
        break;
      case "compile": {
        const optName = (op.optionName as string | undefined) ?? "RebuildAll";
        opLines.push(`batch.Compile(prj, batch.CompileOptions.${optName})`);
        break;
      }
      case "download": {
        const conn = (op.connection as string | undefined) ?? "";
        opLines.push(
          `batch.Download(prj, ${emitPy27String(conn)}, ${op.addLoaderAnyway ? "True" : "False"}, False)`
        );
        const stateJsonPath = logPath.replace(/\.log$/, ".state.json");
        opLines.push(
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
          `f_state = open(${emitPath(stateJsonPath)}, 'w')`,
          "json.dump(result, f_state)",
          "f_state.close()"
        );
        break;
      }
      case "set_task_order":
        opLines.push(
          `batch.SetTaskOrder(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.task as string)}, ${emitPy27String(String(op.position))})`
        );
        break;
      case "set_task_time":
        opLines.push(
          `batch.SetTaskTime(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.task as string)}, ${emitPy27String(op.time as string)})`
        );
        break;
      case "set_task_cpu_core":
        opLines.push(
          `batch.SetTaskCPUCore(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.task as string)}, ${Number(op.core)})`
        );
        break;
      case "set_multi_cpu_core":
        opLines.push(`batch.SetMultiCPUCore(prj, ${op.multiCore ? "True" : "False"})`);
        break;
      case "set_visualized_flag":
        opLines.push(
          `batch.SetVisualizedFlag(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${op.isVisualized ? "True" : "False"})`
        );
        break;
      case "set_comment_network":
        opLines.push(
          `batch.SetCommentNetwork(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.comment as string)})`
        );
        break;
      case "set_comment_object":
        opLines.push(
          `batch.SetCommentObject(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.comment as string)})`
        );
        break;
      case "set_network_options":
        opLines.push(
          `batch.SetNetworkOptions(prj, ${emitPy27String(op.network as string)}, ${emitPy27StringList(op.optionNames as string[])}, ${op.resetAllOthers ? "True" : "False"})`
        );
        break;
      case "reset_network_options":
        opLines.push(
          `batch.ResetNetworkOptions(prj, ${emitPy27String(op.network as string)}, ${emitPy27StringList(op.optionNames as string[])})`
        );
        break;
      case "move_network_to_folder":
        opLines.push(
          `batch.MoveNetworkToFolder(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.folder as string)})`
        );
        break;
      case "set_parameter_value":
        opLines.push(
          `batch.SetParameterValue(prj, ${emitPy27String(op.network as string)}, ${emitPy27String(op.objectName as string)}, ${emitPy27String(op.parameterName as string)}, ${emitPy27String(op.value as string)})`
        );
        break;
      case "save":
        break;
    }

    for (const opLine of opLines) {
      lines.push(`    ${opLine}`);
    }

    lines.push(`    f_step = open(${emitPath(stepsPath)}, "a"); f_step.write("STEP ${label} OK\\n"); f_step.close()`, "");
  }

  lines.push(
    "    batch.Save(prj)",
    "    batch.CloseProject(prj)",
    "except Exception as e:",
    "    traceback.print_exc()",
    "    sys.exit(1)"
  );

  return {
    script: lines.join("\n") + "\n",
    expectedSteps
  };
}

export function buildRawScript(
  lcpPath: string,
  bodyLines: string[],
  logPath: string,
  stepsPath: string,
  expectedSteps: string[]
): string {
  const lines: string[] = [
    "# -*- coding: utf-8 -*-",
    "import sigmatek.lasal.batch as batch",
    "import sys",
    "import json",
    "import traceback",
    "batch.SetExceptionOnError(True)",
    `batch.OpenLogfile(${emitPath(logPath)})`,
    "try:",
    `    prj = batch.LoadProject(${emitPath(lcpPath)})`,
  ];

  for (const line of bodyLines) {
    lines.push(`    ${line}`);
  }

  for (const step of expectedSteps) {
    lines.push(`    f = open(${emitPath(stepsPath)}, "a"); f.write("STEP ${step} OK\\n"); f.close()`);
  }

  lines.push(
    "    batch.CloseProject(prj)",
    "except Exception as e:",
    "    traceback.print_exc()",
    "    sys.exit(1)"
  );

  return lines.join("\n") + "\n";
}

export async function runScript(
  script: string,
  logPath: string,
  timeoutMs = 120_000,
  expectedSteps: string[] = [],
  stepsPath?: string,
): Promise<BatchResult> {
  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `${id}.py`);
  if (!stepsPath) stepsPath = join(SCRATCH, `${id}.steps`);
  writeFileSync(scriptPath, script, "utf-8");

  const command = `"${CLASS2_EXE}" /script:"${scriptPath}"`;

  const result = await runEngineScript(
    scriptPath,
    {
      exe: CLASS2_EXE,
      argsFor: (p) => [`/script:${p}`],
      timeoutMs,
      logEncoding: "latin1",
      killOnFailure: killClass2,
      expectedSteps,
      stepsPath,
    },
    logPath,
  );

  return {
    ok: result.ok,
    exitCode: result.exitCode,
    logPath: result.logPath,
    errors: result.errors,
    warnings: result.warnings,
    logTail: result.logTail,
    durationMs: result.durationMs,
    command,
    steps: result.steps,
    timedOut: result.timedOut,
    hints: result.hints,
  };
}

export async function runBatchOps(
  lcpPath: string,
  ops: BatchOp[],
  timeoutMs = 120_000,
): Promise<BatchResult> {
  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `${id}.py`);
  const logPath = join(SCRATCH, `${id}.log`);
  const stepsPath = join(SCRATCH, `${id}.steps`);

  const { script, expectedSteps } = buildBatchScript(lcpPath, ops, logPath, stepsPath);
  writeFileSync(scriptPath, script, "utf-8");

  const command = `"${CLASS2_EXE}" /script:"${scriptPath}"`;

  killClass2();

  const result = await runEngineScript(
    scriptPath,
    {
      exe: CLASS2_EXE,
      argsFor: (p) => [`/script:${p}`],
      timeoutMs,
      logEncoding: "latin1",
      killOnFailure: killClass2,
      expectedSteps,
      stepsPath,
    },
    logPath,
  );

  let postDownloadState: Record<string, unknown> | undefined;
  const stateJsonPath = logPath.replace(/\.log$/, ".state.json");
  if (existsSync(stateJsonPath)) {
    try {
      postDownloadState = JSON.parse(readFileSync(stateJsonPath, "utf-8"));
    } catch {}
  }

  return {
    ok: result.ok,
    exitCode: result.exitCode,
    logPath: result.logPath,
    errors: result.errors,
    warnings: result.warnings,
    logTail: result.logTail,
    durationMs: result.durationMs,
    command,
    steps: result.steps,
    timedOut: result.timedOut,
    hints: result.hints,
    postDownloadState,
  };
}
