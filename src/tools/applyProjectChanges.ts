import { z } from "zod";
import { runBatchOps, type BatchOp } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { withEngineLock, killClass2, killVisuDesigner } from "../utils/engine.js";
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
  options: z.enum(["RebuildAll", "BuildChanges", "UserClassesOnly", "NoDebugInfo"])
    .optional().default("RebuildAll"),
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

const OperationSchema = z.discriminatedUnion("type", [
  CreateNetworkOp, DeleteNetworkOp, RenameNetworkOp, DuplicateNetworkOp,
  AddObjectOp, RemoveObjectOp, RenameObjectOp, ChangeObjectClassOp,
  CreateConnectionOp, DeleteConnectionOp, SetInitValueOp,
  DeleteClassOp,
  CompileOp, DownloadOp,
  SetTaskOrderOp, SetTaskTimeOp, SetTaskCpuCoreOp, SetMultiCpuCoreOp,
  SetVisualizedFlagOp,
  SetCommentNetworkOp, SetCommentObjectOp,
  SetNetworkOptionsOp, ResetNetworkOptionsOp,
  MoveNetworkToFolderOp,
  SetParameterValueOp,
]);

type Operation = z.infer<typeof OperationSchema>;

export const applyProjectChangesSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  operations: z
    .array(OperationSchema)
    .describe(
      "Ordered list of CLASS 2 batch engine operations. " +
      "Available types: create_network, delete_network, rename_network, duplicate_network, " +
      "add_object, remove_object, rename_object, change_object_class, " +
      "create_connection, delete_connection, set_init_value, delete_class, " +
      "compile, download, set_task_order, set_task_time, set_task_cpu_core, " +
      "set_multi_cpu_core, set_visualized_flag, set_comment_network, set_comment_object, " +
      "set_network_options, reset_network_options, move_network_to_folder, set_parameter_value"
    ),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("Validate operations without applying them."),
};

function toBatchOp(op: Operation): BatchOp {
  switch (op.type) {
    case "create_network": return { type: "create_network", name: op.name };
    case "delete_network": return { type: "delete_network", name: op.name, deleteConnections: op.deleteConnections };
    case "rename_network": return { type: "rename_network", oldName: op.oldName, newName: op.newName };
    case "duplicate_network": return { type: "duplicate_network", name: op.name, newName: op.newName };
    case "add_object": return { type: "add_object", network: op.network, className: op.className, objectName: op.objectName, x: op.x, y: op.y, visualized: op.visualized };
    case "remove_object": return { type: "remove_object", network: op.network, objectName: op.objectName, deleteConnections: op.deleteConnections };
    case "rename_object": return { type: "rename_object", network: op.network, oldName: op.oldName, newName: op.newName };
    case "change_object_class": return { type: "change_object_class", network: op.network, objectName: op.objectName, className: op.className };
    case "create_connection": return { type: "create_connection", network: op.network, fromObject: op.fromObject, fromClient: op.fromClient, toObject: op.toObject, toServer: op.toServer };
    case "delete_connection": return { type: "delete_connection", network: op.network, objectName: op.objectName, clientName: op.clientName };
    case "set_init_value": return { type: "set_init_value", network: op.network, objectName: op.objectName, channelName: op.channelName, value: op.value };
    case "delete_class": return { type: "delete_class", className: op.className, force: op.force };
    case "compile": return { type: "compile", optionName: op.options };
    case "download": return { type: "download", connection: op.connection ?? "", addLoaderAnyway: op.add_loader_anyway };
    case "set_task_order": return { type: "set_task_order", network: op.network, objectName: op.objectName, task: op.task, position: op.position };
    case "set_task_time": return { type: "set_task_time", network: op.network, objectName: op.objectName, task: op.task, time: op.time };
    case "set_task_cpu_core": return { type: "set_task_cpu_core", network: op.network, objectName: op.objectName, task: op.task, core: op.core };
    case "set_multi_cpu_core": return { type: "set_multi_cpu_core", multiCore: op.multiCore };
    case "set_visualized_flag": return { type: "set_visualized_flag", network: op.network, objectName: op.objectName, isVisualized: op.isVisualized };
    case "set_comment_network": return { type: "set_comment_network", network: op.network, comment: op.comment };
    case "set_comment_object": return { type: "set_comment_object", network: op.network, objectName: op.objectName, comment: op.comment };
    case "set_network_options": return { type: "set_network_options", network: op.network, optionNames: op.optionNames, resetAllOthers: op.resetAllOthers };
    case "reset_network_options": return { type: "reset_network_options", network: op.network, optionNames: op.optionNames };
    case "move_network_to_folder": return { type: "move_network_to_folder", network: op.network, folder: op.folder };
    case "set_parameter_value": return { type: "set_parameter_value", network: op.network, objectName: op.objectName, parameterName: op.parameterName, value: op.value };
  }
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
        target: (op as any).name ?? (op as any).network ?? (op as any).objectName ?? "",
      }));
      return respond({
        ok: true,
        dryRun: true,
        operationCount: ops.length,
        plan,
        hints: ["Pass dry_run: false (or omit it) to apply these operations."],
      });
    }

    killClass2();
    killVisuDesigner();

    const batchOps: BatchOp[] = ops.map(toBatchOp);
    const results = ops.map((op) => ({
      op: op.type,
      target: (op as any).name ?? (op as any).objectName ?? (op as any).network ?? "",
      ok: true,
      message: "Queued for batch",
    }));

    const br = await runBatchOps(resolved.path, batchOps);

    const batchResult = {
      ok: br.ok,
      exitCode: br.exitCode,
      durationMs: br.durationMs,
      errors: br.errors,
      warnings: br.warnings,
      logPath: br.logPath,
    };

    for (const r of results) {
      if (br.ok) {
        r.message = "Applied via batch";
      } else {
        r.ok = false;
        r.message = "Batch script failed — see batchResult.errors";
      }
    }

    return respond({
      ok: br.ok,
      operations: results,
      batchResult,
    });
  });
}
