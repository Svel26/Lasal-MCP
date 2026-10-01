import { z } from "zod";
import { runBatchOps, type BatchOp } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { withEngineLock, killClass2, killVisuDesigner } from "../utils/engine.js";
import {
  createClass,
  registerProjectFile,
  clearProjectCaches,
  clearProjectBuildArtifacts,
  type CreateClassOptions,
} from "../utils/lcpManifest.js";
import { respond, fail } from "../utils/respond.js";

// ─── Batch operation schemas (all require CLASS 2 engine) ────────────────────

const CreateNetworkOp = z.object({
  type: z.literal("create_network"),
  name: z.string(),
});

const DeleteNetworkOp = z.object({
  type: z.literal("delete_network"),
  name: z.string(),
  deleteConnections: z.boolean().optional().default(true),
});

const RenameNetworkOp = z.object({
  type: z.literal("rename_network"),
  oldName: z.string(),
  newName: z.string(),
});

const DuplicateNetworkOp = z.object({
  type: z.literal("duplicate_network"),
  name: z.string(),
  newName: z.string(),
});

const AddObjectOp = z.object({
  type: z.literal("add_object"),
  network: z.string(),
  className: z.string(),
  objectName: z.string(),
  x: z.number().optional().default(300),
  y: z.number().optional().default(300),
  visualized: z.boolean().optional().default(true),
});

const RemoveObjectOp = z.object({
  type: z.literal("remove_object"),
  network: z.string(),
  objectName: z.string(),
  deleteConnections: z.boolean().optional().default(true),
});

const RenameObjectOp = z.object({
  type: z.literal("rename_object"),
  network: z.string(),
  oldName: z.string(),
  newName: z.string(),
});

const ChangeObjectClassOp = z.object({
  type: z.literal("change_object_class"),
  network: z.string(),
  objectName: z.string(),
  className: z.string(),
});

const CreateConnectionOp = z.object({
  type: z.literal("create_connection"),
  network: z.string().optional(),
  fromObject: z.string(),
  fromClient: z.string(),
  toObject: z.string(),
  toServer: z.string(),
});

const DeleteConnectionOp = z.object({
  type: z.literal("delete_connection"),
  network: z.string().optional(),
  objectName: z.string(),
  clientName: z.string(),
});

const SetInitValueOp = z.object({
  type: z.literal("set_init_value"),
  network: z.string().optional(),
  objectName: z.string(),
  channelName: z.string(),
  value: z.string(),
});

const DeleteClassOp = z.object({
  type: z.literal("delete_class"),
  className: z.string(),
  force: z.boolean().optional().default(false),
});

const CompileOp = z.object({
  type: z.literal("compile"),
  options: z.enum(["RebuildAll", "BuildChanges", "UserClassesOnly", "NoDebugInfo"]).optional().default("RebuildAll"),
});

const DownloadOp = z.object({
  type: z.literal("download"),
  connection: z.string().optional(),
  add_loader_anyway: z.boolean().optional().default(false),
});

const SetTaskOrderOp = z.object({
  type: z.literal("set_task_order"),
  network: z.string(),
  objectName: z.string(),
  task: z.enum(["realtime", "cyclicwork", "background"]),
  position: z.number().int(),
});

const SetTaskTimeOp = z.object({
  type: z.literal("set_task_time"),
  network: z.string(),
  objectName: z.string(),
  task: z.enum(["realtime", "cyclicwork", "background"]),
  time: z.string(),
});

const SetTaskCpuCoreOp = z.object({
  type: z.literal("set_task_cpu_core"),
  network: z.string(),
  objectName: z.string(),
  task: z.enum(["realtime", "cyclicwork"]),
  core: z.number().int(),
});

const SetMultiCpuCoreOp = z.object({
  type: z.literal("set_multi_cpu_core"),
  multiCore: z.boolean(),
});

const SetVisualizedFlagOp = z.object({
  type: z.literal("set_visualized_flag"),
  network: z.string(),
  objectName: z.string(),
  isVisualized: z.boolean(),
});

const SetCommentNetworkOp = z.object({
  type: z.literal("set_comment_network"),
  network: z.string(),
  comment: z.string(),
});

const SetCommentObjectOp = z.object({
  type: z.literal("set_comment_object"),
  network: z.string(),
  objectName: z.string(),
  comment: z.string(),
});

const SetNetworkOptionsOp = z.object({
  type: z.literal("set_network_options"),
  network: z.string(),
  optionNames: z.array(z.string()),
  resetAllOthers: z.boolean().optional().default(false),
});

const ResetNetworkOptionsOp = z.object({
  type: z.literal("reset_network_options"),
  network: z.string(),
  optionNames: z.array(z.string()),
});

const MoveNetworkToFolderOp = z.object({
  type: z.literal("move_network_to_folder"),
  network: z.string(),
  folder: z.string(),
});

const SetParameterValueOp = z.object({
  type: z.literal("set_parameter_value"),
  network: z.string(),
  objectName: z.string(),
  parameterName: z.string(),
  value: z.string(),
});

const SetCompilerVersionOp = z.object({
  type: z.literal("set_compiler_version"),
  version: z.string().describe("Compiler version string accepted by batch.SetCompilerVersion (e.g. 'C75')."),
});

// ─── File-level operations (no CLASS 2 batch API) ────────────────────────────

const ClassServerSpec = z.object({
  name: z.string().describe("Server (channel) name."),
  type: z.string().optional().default("SvrCh_DINT").describe("ST channel type (SvrCh_*, default SvrCh_DINT)."),
  visualized: z.boolean().optional().default(true),
  retentive: z.boolean().optional().default(false),
  initialize: z.boolean().optional().default(false),
});

const ClassFileSpec = z.object({
  path: z.string().describe("Path relative to the project (e.g. .\\Class\\PbLib\\C_PbLib.cpp) or absolute."),
  include: z.boolean().optional().describe("Header: emit an #include in the class .st (default true for *.h)."),
  global: z.boolean().optional().describe('Header: set Global="true" in <HeaderFiles>.'),
  content: z.string().optional().describe("Optional latin1 content to write to the file."),
});

const CreateClassOp = z.object({
  type: z.literal("create_class"),
  name: z.string().describe("Class name ([A-Za-z_][A-Za-z0-9_]*)."),
  folder: z.string().optional().default("IQ").describe("Class browser folder under <ClassFolders>."),
  revision: z.string().optional().default("0.1"),
  comment: z.string().optional(),
  company: z.string().optional().default("Votech"),
  author: z.string().optional().default("lasal-mcp"),
  cyclicTask: z.boolean().optional().default(false),
  realtimeTask: z.boolean().optional().default(false),
  backgroundTask: z.boolean().optional().default(false),
  defCyclicTime: z.string().optional().default("cCyTb"),
  defBackgroundTime: z.string().optional().default("cBgTb"),
  servers: z
    .array(ClassServerSpec)
    .optional()
    .default([])
    .describe("Extra server channels (ClassSvr is always added)."),
  files: z
    .array(ClassFileSpec)
    .optional()
    .default([])
    .describe("Class dependency files (.h/.cpp), optionally created."),
});

const AddProjectFileOp = z.object({
  type: z.literal("add_project_file"),
  path: z.string().describe("Existing file to register (relative to the project or absolute)."),
  header: z.boolean().optional().describe("Force registration in <HeaderFiles> even when the name does not end in .h."),
  global: z.boolean().optional().default(false).describe('Header: set Global="true".'),
});

const CleanProjectOp = z.object({
  type: z.literal("clean_project"),
  caches: z.boolean().optional().default(true).describe("Delete ProjectInternal/BrowserInfo.bin and LobInfo.bin."),
  deep: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Also delete the generated .lcb and Network/ConfigObjects .lob/.lba (forces a full relink). " +
        "Use to recover after a class was removed by deleting its folder instead of the batch delete_class operation.",
    ),
});

const OperationSchema = z.discriminatedUnion("type", [
  CreateNetworkOp,
  DeleteNetworkOp,
  RenameNetworkOp,
  DuplicateNetworkOp,
  AddObjectOp,
  RemoveObjectOp,
  RenameObjectOp,
  ChangeObjectClassOp,
  CreateConnectionOp,
  DeleteConnectionOp,
  SetInitValueOp,
  DeleteClassOp,
  CompileOp,
  DownloadOp,
  SetTaskOrderOp,
  SetTaskTimeOp,
  SetTaskCpuCoreOp,
  SetMultiCpuCoreOp,
  SetVisualizedFlagOp,
  SetCommentNetworkOp,
  SetCommentObjectOp,
  SetNetworkOptionsOp,
  ResetNetworkOptionsOp,
  MoveNetworkToFolderOp,
  SetParameterValueOp,
  SetCompilerVersionOp,
  CreateClassOp,
  AddProjectFileOp,
  CleanProjectOp,
]);

type Operation = z.infer<typeof OperationSchema>;
type FileOperation = Extract<Operation, { type: "create_class" | "add_project_file" | "clean_project" }>;
type BatchOperation = Exclude<Operation, FileOperation>;

function isFileOperation(op: Operation): op is FileOperation {
  return op.type === "create_class" || op.type === "add_project_file" || op.type === "clean_project";
}

export const applyProjectChangesSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  operations: z
    .array(OperationSchema)
    .describe(
      "Ordered list of operations. Batch engine types: create_network, delete_network, rename_network, " +
        "duplicate_network, add_object, remove_object, rename_object, change_object_class, " +
        "create_connection, delete_connection, set_init_value, delete_class, compile, download, " +
        "set_task_order, set_task_time, set_task_cpu_core, set_multi_cpu_core, set_visualized_flag, " +
        "set_comment_network, set_comment_object, set_network_options, reset_network_options, " +
        "move_network_to_folder, set_parameter_value, set_compiler_version. " +
        "File-level types (applied before the batch engine, no CLASS 2 API): create_class, " +
        "add_project_file, clean_project.",
    ),
  dry_run: z.boolean().optional().default(false).describe("Validate operations without applying them."),
};

function fileOperationTarget(op: FileOperation): string {
  switch (op.type) {
    case "create_class":
      return op.name;
    case "add_project_file":
      return op.path;
    case "clean_project":
      return "ProjectInternal";
  }
}

function executeFileOperation(lcpPath: string, op: FileOperation): Record<string, unknown> {
  switch (op.type) {
    case "create_class": {
      const options: CreateClassOptions = {
        name: op.name,
        folder: op.folder,
        revision: op.revision,
        comment: op.comment,
        company: op.company,
        author: op.author,
        cyclicTask: op.cyclicTask,
        realtimeTask: op.realtimeTask,
        backgroundTask: op.backgroundTask,
        defCyclicTime: op.defCyclicTime,
        defBackgroundTime: op.defBackgroundTime,
        servers: op.servers,
        files: op.files,
      };
      return { ...createClass(lcpPath, options) };
    }
    case "add_project_file":
      return { ...registerProjectFile(lcpPath, op.path, { header: op.header, global: op.global }) };
    case "clean_project": {
      if (op.deep) {
        return { buildArtifactsCleared: clearProjectBuildArtifacts(lcpPath) };
      }
      const cleared = op.caches === false ? [] : clearProjectCaches(lcpPath);
      return { cachesCleared: cleared };
    }
  }
}

function toBatchOp(op: BatchOperation): BatchOp {
  switch (op.type) {
    case "create_network":
      return { type: "create_network", name: op.name };
    case "delete_network":
      return { type: "delete_network", name: op.name, deleteConnections: op.deleteConnections };
    case "rename_network":
      return { type: "rename_network", oldName: op.oldName, newName: op.newName };
    case "duplicate_network":
      return { type: "duplicate_network", name: op.name, newName: op.newName };
    case "add_object":
      return {
        type: "add_object",
        network: op.network,
        className: op.className,
        objectName: op.objectName,
        x: op.x,
        y: op.y,
        visualized: op.visualized,
      };
    case "remove_object":
      return {
        type: "remove_object",
        network: op.network,
        objectName: op.objectName,
        deleteConnections: op.deleteConnections,
      };
    case "rename_object":
      return { type: "rename_object", network: op.network, oldName: op.oldName, newName: op.newName };
    case "change_object_class":
      return { type: "change_object_class", network: op.network, objectName: op.objectName, className: op.className };
    case "create_connection":
      return {
        type: "create_connection",
        network: op.network,
        fromObject: op.fromObject,
        fromClient: op.fromClient,
        toObject: op.toObject,
        toServer: op.toServer,
      };
    case "delete_connection":
      return { type: "delete_connection", network: op.network, objectName: op.objectName, clientName: op.clientName };
    case "set_init_value":
      return {
        type: "set_init_value",
        network: op.network,
        objectName: op.objectName,
        channelName: op.channelName,
        value: op.value,
      };
    case "delete_class":
      return { type: "delete_class", className: op.className, force: op.force };
    case "compile":
      return { type: "compile", optionName: op.options };
    case "download":
      return { type: "download", connection: op.connection ?? "", addLoaderAnyway: op.add_loader_anyway };
    case "set_task_order":
      return {
        type: "set_task_order",
        network: op.network,
        objectName: op.objectName,
        task: op.task,
        position: op.position,
      };
    case "set_task_time":
      return { type: "set_task_time", network: op.network, objectName: op.objectName, task: op.task, time: op.time };
    case "set_task_cpu_core":
      return {
        type: "set_task_cpu_core",
        network: op.network,
        objectName: op.objectName,
        task: op.task,
        core: op.core,
      };
    case "set_multi_cpu_core":
      return { type: "set_multi_cpu_core", multiCore: op.multiCore };
    case "set_visualized_flag":
      return {
        type: "set_visualized_flag",
        network: op.network,
        objectName: op.objectName,
        isVisualized: op.isVisualized,
      };
    case "set_comment_network":
      return { type: "set_comment_network", network: op.network, comment: op.comment };
    case "set_comment_object":
      return { type: "set_comment_object", network: op.network, objectName: op.objectName, comment: op.comment };
    case "set_network_options":
      return {
        type: "set_network_options",
        network: op.network,
        optionNames: op.optionNames,
        resetAllOthers: op.resetAllOthers,
      };
    case "reset_network_options":
      return { type: "reset_network_options", network: op.network, optionNames: op.optionNames };
    case "move_network_to_folder":
      return { type: "move_network_to_folder", network: op.network, folder: op.folder };
    case "set_parameter_value":
      return {
        type: "set_parameter_value",
        network: op.network,
        objectName: op.objectName,
        parameterName: op.parameterName,
        value: op.value,
      };
    case "set_compiler_version":
      return { type: "set_compiler_version", version: op.version };
  }
}

function batchOperationTarget(op: BatchOperation): string {
  const rec = op as Record<string, unknown>;
  return String(rec.name ?? rec.objectName ?? rec.network ?? "");
}

export async function applyProjectChangesHandler(args: {
  lcp_path?: string;
  operations: unknown[];
  dry_run?: boolean;
}) {
  return withEngineLock(async () => {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) {
      return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
    }

    const ops: Operation[] = [];
    const parseErrors: string[] = [];
    for (let i = 0; i < args.operations.length; i++) {
      const result = OperationSchema.safeParse(args.operations[i]);
      if (result.success) {
        ops.push(result.data);
      } else {
        parseErrors.push(`Operation[${i}]: ${result.error.message}`);
      }
    }
    if (parseErrors.length) {
      return fail(`Invalid operations:\n${parseErrors.join("\n")}`, []);
    }

    if (args.dry_run) {
      const plan = ops.map((op, i) => ({
        index: i,
        type: op.type,
        target: isFileOperation(op) ? fileOperationTarget(op) : batchOperationTarget(op),
      }));
      return respond({
        ok: true,
        dryRun: true,
        operationCount: ops.length,
        plan,
        hints: ["Pass dry_run: false (or omit it) to apply these operations."],
      });
    }

    const hasFileOps = ops.some(isFileOperation);
    if (hasFileOps) {
      // File-level operations rewrite the .lcp; the IDE must not hold the project.
      killClass2();
      killVisuDesigner();
    }

    interface OpOutcome {
      index: number;
      type: string;
      target: string;
      ok: boolean;
      message: string;
      detail?: unknown;
    }
    const outcomes: OpOutcome[] = [];
    const batchOps: BatchOp[] = [];
    let fileFailure = false;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (isFileOperation(op)) {
        if (fileFailure) {
          outcomes.push({
            index: i,
            type: op.type,
            target: fileOperationTarget(op),
            ok: false,
            message: "Skipped because an earlier file operation failed.",
          });
          continue;
        }
        try {
          const detail = executeFileOperation(resolved.path, op);
          outcomes.push({
            index: i,
            type: op.type,
            target: fileOperationTarget(op),
            ok: true,
            message: "Applied to project files",
            detail,
          });
        } catch (e) {
          fileFailure = true;
          outcomes.push({
            index: i,
            type: op.type,
            target: fileOperationTarget(op),
            ok: false,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        batchOps.push(toBatchOp(op));
        outcomes.push({
          index: i,
          type: op.type,
          target: batchOperationTarget(op),
          ok: true,
          message: "Queued for batch",
        });
      }
    }

    let batchResult: Record<string, unknown> | undefined;
    let batchOk = true;
    if (batchOps.length > 0 && !fileFailure) {
      killClass2();
      killVisuDesigner();
      const br = await runBatchOps(resolved.path, batchOps);
      batchOk = br.ok;
      batchResult = {
        ok: br.ok,
        exitCode: br.exitCode,
        durationMs: br.durationMs,
        errors: br.errors,
        warnings: br.warnings,
        logPath: br.logPath,
      };
      for (const o of outcomes) {
        if (o.message === "Queued for batch") {
          o.ok = br.ok;
          o.message = br.ok ? "Applied via batch" : "Batch script failed - see batchResult.errors";
        }
      }
    }

    const hints: string[] = [];
    if (hasFileOps) {
      hints.push("Run a compile operation (or build_project) to validate the project files after these edits.");
    }
    if (ops.some((op) => op.type === "create_class")) {
      hints.push(
        "Generated class and channels have valid IEEE 802.3 CRC-32 GUID hashes populated automatically in the @CT_ table.",
      );
      hints.push(
        "The generated class has no task methods (CyWork/Init) yet - add them in CLASS 2 or via read_class_source before scheduling a task.",
      );
    }
    const batchErrors = batchResult && Array.isArray(batchResult.errors) ? (batchResult.errors as string[]) : [];
    if (batchErrors.some((e) => /No file entry found/i.test(e))) {
      hints.push(
        "The compiler referenced a file missing from the .lcp manifest (or ProjectInternal/BrowserInfo.bin is stale): run clean_project, re-register via add_project_file/create_class, then rebuild.",
      );
    }

    return respond({
      ok: !fileFailure && batchOk,
      operations: outcomes,
      ...(batchResult ? { batchResult } : {}),
      hints,
    });
  });
}
