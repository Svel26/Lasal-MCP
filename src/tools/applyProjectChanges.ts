import { existsSync } from "fs";
import { basename } from "path";
import { z } from "zod";
import {
  parseLcp,
  parseStClass,
  parseLcn,
  addServerToSt,
  removeServerFromSt,
  renameServerInSt,
  addClientToSt,
  removeClientFromSt,
  renameClientInSt,
  cascadeRenameServerInLcn,
  cascadeRenameClientInLcn,
  cascadeRemoveClientFromLcn,
  cascadeRemoveServerFromLcn,
  findObjectsOfClass,
  addServerTypeToStBody,
  removeServerTypeFromStBody,
  renameServerInStBody,
  addClientTypeToStBody,
  removeClientTypeFromStBody,
  renameClientInStBody,
  addVariableToSt,
  removeVariableFromSt,
  renameVariableInSt,
  addMethodToSt,
  removeMethodFromSt,
  renameMethodInSt,
} from "../utils/lasalXml.js";
import { runBatchOps, type BatchOp } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { withEngineLock, killClass2, killVisuDesigner } from "../utils/engine.js";
import { EditTransaction } from "../utils/editTransaction.js";
import { respond, fail } from "../utils/respond.js";

// ─── Operation schemas ────────────────────────────────────────────────────────

const AddServerOp = z.object({
  type: z.literal("add_server"),
  className: z.string(),
  name: z.string(),
  stType: z.string().describe("ST type declaration, e.g. 'SvrCh_DINT', 'SvrCh_BOOL'."), // Required now
  visualized: z.boolean().optional().default(true),
  initialize: z.boolean().optional().default(false),
  defValue: z.string().optional(),
  writeProtected: z.boolean().optional().default(false),
  retentive: z.string().optional().default("false"),
  comment: z.string().optional(),
});

const RemoveServerOp = z.object({
  type: z.literal("remove_server"),
  className: z.string(),
  name: z.string(),
});

const RenameServerOp = z.object({
  type: z.literal("rename_server"),
  className: z.string(),
  oldName: z.string(),
  newName: z.string(),
});

const AddClientOp = z.object({
  type: z.literal("add_client"),
  className: z.string(),
  name: z.string(),
  stType: z.string().describe("ST type declaration, e.g. 'CltChCmd_General2', 'CltChCmd_Ram'."), // Required now
  required: z.boolean().optional().default(false),
  internal: z.boolean().optional().default(false),
  comment: z.string().optional(),
});

const RemoveClientOp = z.object({
  type: z.literal("remove_client"),
  className: z.string(),
  name: z.string(),
});

const RenameClientOp = z.object({
  type: z.literal("rename_client"),
  className: z.string(),
  oldName: z.string(),
  newName: z.string(),
});

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
    .optional().default("RebuildAll")
    .describe("Compile mode. RebuildAll is safest. BuildChanges is faster for incremental work."),
});

const DownloadOp = z.object({
  type: z.literal("download"),
  connection: z.string().optional()
    .describe("Connection string (e.g. 'TCPIP:192.168.1.100') or address-book name. Omit to use the project's saved connection."),
  add_loader_anyway: z.boolean().optional().default(false),
});

const SetTaskOrderOp = z.object({
  type: z.literal("set_task_order"),
  network: z.string(),
  objectName: z.string(),
  task: z.enum(["realtime", "cyclicwork", "background"]),
  position: z.number().int().describe("New task execution position (1-based)."),
});

const SetTaskTimeOp = z.object({
  type: z.literal("set_task_time"),
  network: z.string(),
  objectName: z.string(),
  task: z.enum(["realtime", "cyclicwork", "background"]),
  time: z.string().describe("Task cycle time as a string, e.g. '10ms', '1s'."),
});

const SetTaskCpuCoreOp = z.object({
  type: z.literal("set_task_cpu_core"),
  network: z.string(),
  objectName: z.string(),
  task: z.enum(["realtime", "cyclicwork"]),
  core: z.number().int().describe("CPU core index (0-based)."),
});

const SetMultiCpuCoreOp = z.object({
  type: z.literal("set_multi_cpu_core"),
  multiCore: z.boolean().describe("Enable or disable multi-core CPU usage for the project."),
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
  optionNames: z.array(z.string()).describe("Option names to enable on the network."),
  resetAllOthers: z.boolean().optional().default(false)
    .describe("If true, disable all options not listed in optionNames."),
});

const ResetNetworkOptionsOp = z.object({
  type: z.literal("reset_network_options"),
  network: z.string(),
  optionNames: z.array(z.string()).describe("Option names to disable on the network."),
});

const MoveNetworkToFolderOp = z.object({
  type: z.literal("move_network_to_folder"),
  network: z.string(),
  folder: z.string().describe("Folder path, e.g. 'Group/SubGroup'. Created automatically if it does not exist."),
});

const SetParameterValueOp = z.object({
  type: z.literal("set_parameter_value"),
  network: z.string(),
  objectName: z.string(),
  parameterName: z.string(),
  value: z.string(),
});

const AddVariableOp = z.object({
  type: z.literal("add_variable"),
  className: z.string(),
  name: z.string(),
  varType: z.string().describe("ST type, e.g. 'DINT', 'BOOL', 'ARRAY [0..9] OF UDINT'"),
});

const RemoveVariableOp = z.object({
  type: z.literal("remove_variable"),
  className: z.string(),
  name: z.string(),
});

const RenameVariableOp = z.object({
  type: z.literal("rename_variable"),
  className: z.string(),
  oldName: z.string(),
  newName: z.string(),
  renameInBody: z.boolean().optional().default(false)
    .describe("Also rename whole-word occurrences in method implementations. Use with care."),
});

const MethodParamSchema = z.object({
  name: z.string(),
  type: z.string(),
  direction: z.enum(["input", "output", "in_out"]).optional().default("input"),
});

const AddMethodOp = z.object({
  type: z.literal("add_method"),
  className: z.string(),
  name: z.string(),
  modifiers: z.array(z.string()).optional().default([])
    .describe("e.g. ['VIRTUAL', 'GLOBAL']"),
  params: z.array(MethodParamSchema).optional().default([]),
  body: z.string().optional()
    .describe("Initial implementation body. Defaults to a TODO comment."),
});

const RemoveMethodOp = z.object({
  type: z.literal("remove_method"),
  className: z.string(),
  name: z.string(),
});

const RenameMethodOp = z.object({
  type: z.literal("rename_method"),
  className: z.string(),
  oldName: z.string(),
  newName: z.string(),
});

const OperationSchema = z.discriminatedUnion("type", [
  AddServerOp, RemoveServerOp, RenameServerOp,
  AddClientOp, RemoveClientOp, RenameClientOp,
  AddVariableOp, RemoveVariableOp, RenameVariableOp,
  AddMethodOp, RemoveMethodOp, RenameMethodOp,
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
      "Ordered list of operations to apply. " +
      "Each has a 'type' field. " +
      "Channel ops (add_server, add_client, etc.) edit .st files. " +
      "Network ops (create_network, add_object, etc.) edit .lcn files."
    ),
  validate_compile: z
    .boolean()
    .optional()
    .default(false)
    .describe("Run compile changes after applying modifications to verify project syntax validity."),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("Validate operations without applying them. Returns what would be changed."),
};

const DIRECT_EDIT_TYPES = new Set([
  "add_server", "remove_server", "rename_server",
  "add_client", "remove_client", "rename_client",
  "add_variable", "remove_variable", "rename_variable",
  "add_method", "remove_method", "rename_method"
]);

const BATCH_OP_TYPES = new Set([
  "create_network", "delete_network", "rename_network", "duplicate_network",
  "add_object", "remove_object", "rename_object", "change_object_class",
  "create_connection", "delete_connection", "set_init_value",
  "delete_class", "compile", "download",
  "set_task_order", "set_task_time", "set_task_cpu_core", "set_multi_cpu_core",
  "set_visualized_flag", "set_comment_network", "set_comment_object",
  "set_network_options", "reset_network_options", "move_network_to_folder",
  "set_parameter_value"
]);

function killIde() {
  killClass2();
  killVisuDesigner();
}

function findStForClass(classFiles: { absPath: string }[], className: string): string | null {
  for (const cf of classFiles) {
    if (!cf.absPath.endsWith(".st")) continue;
    try {
      const info = parseStClass(cf.absPath);
      if (info.name === className) return cf.absPath;
    } catch { /* skip unparseable */ }
  }
  return null;
}

export async function applyProjectChangesHandler(args: {
  lcp_path?: string;
  operations: unknown[];
  validate_compile?: boolean;
  dry_run?: boolean;
}) {
  return withEngineLock(async () => {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) {
      return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
    }

    // Parse operations
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

    // Check mixed lists
    const hasDirect = ops.some(o => DIRECT_EDIT_TYPES.has(o.type));
    const hasBatch = ops.some(o => BATCH_OP_TYPES.has(o.type));
    if (hasDirect && hasBatch) {
      return fail(
        "Mixed operation lists are not allowed.",
        [
          "Split your changes into two separate tool calls: first send direct edits (e.g. add_server, add_client), then send batch operations (e.g. add_object, create_connection)."
        ]
      );
    }

    if (args.dry_run) {
      const plan = ops.map((op, i) => ({
        index: i,
        type: op.type,
        target: (op as any).className ?? (op as any).network ?? (op as any).objectName ?? "",
        mode: DIRECT_EDIT_TYPES.has(op.type) ? "direct_edit" : "batch",
      }));
      return respond({
        ok: true,
        dryRun: true,
        operationCount: ops.length,
        plan,
        hints: ["Pass dry_run: false (or omit it) to apply these operations."],
      });
    }

    let lcpInfo;
    try {
      lcpInfo = parseLcp(resolved.path);
    } catch (e: any) {
      return fail(`Failed to parse .lcp: ${e.message}`, []);
    }

    const lcnPaths = lcpInfo.networkFiles.map((n) => n.absPath);

    // Kill IDE before any modifications
    killIde();

    const results: Array<{ op: string; ok: boolean; message: string }> = [];
    const batchOps: BatchOp[] = [];

    const tx = new EditTransaction();
    const touchedFiles = new Set<string>();

    if (hasDirect) {
      try {
        for (const op of ops) {
          switch (op.type) {
            case "add_server": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              addServerToSt(stPath, {
                name: op.name,
                visualized: op.visualized,
                initialize: op.initialize,
                defValue: op.defValue,
                writeProtected: op.writeProtected,
                retentive: op.retentive,
                comment: op.comment,
              });
              addServerTypeToStBody(stPath, op.name, op.stType);
              results.push({ op: `add_server(${op.className}, ${op.name})`, ok: true, message: "Added server to XML block + ST body" });
              break;
            }

            case "remove_server": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              removeServerFromSt(stPath, op.name);
              removeServerTypeFromStBody(stPath, op.name);
              const objMap = findObjectsOfClass(lcnPaths, op.className);
              for (const [lcnPath, objNames] of objMap) {
                tx.backup(lcnPath);
                touchedFiles.add(lcnPath);
                cascadeRemoveServerFromLcn(lcnPath, op.className, op.name, objNames);
              }
              results.push({ op: `remove_server(${op.className}, ${op.name})`, ok: true, message: `Updated XML block, ST body, ${objMap.size} network file(s)` });
              break;
            }

            case "rename_server": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              renameServerInSt(stPath, op.oldName, op.newName);
              renameServerInStBody(stPath, op.oldName, op.newName);
              const objMap = findObjectsOfClass(lcnPaths, op.className);
              for (const [lcnPath] of objMap) {
                tx.backup(lcnPath);
                touchedFiles.add(lcnPath);
                cascadeRenameServerInLcn(lcnPath, op.className, op.oldName, op.newName);
              }
              results.push({ op: `rename_server(${op.className}, ${op.oldName}→${op.newName})`, ok: true, message: `Updated XML block, ST body, ${objMap.size} network file(s)` });
              break;
            }

            case "add_client": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              addClientToSt(stPath, {
                name: op.name,
                required: op.required,
                internal: op.internal,
                comment: op.comment,
              });
              addClientTypeToStBody(stPath, op.name, op.stType);
              results.push({ op: `add_client(${op.className}, ${op.name})`, ok: true, message: "Added client to XML block + ST body" });
              break;
            }

            case "remove_client": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              removeClientFromSt(stPath, op.name);
              removeClientTypeFromStBody(stPath, op.name);
              const objMap = findObjectsOfClass(lcnPaths, op.className);
              for (const [lcnPath, objNames] of objMap) {
                tx.backup(lcnPath);
                touchedFiles.add(lcnPath);
                cascadeRemoveClientFromLcn(lcnPath, op.className, op.name, objNames);
              }
              results.push({ op: `remove_client(${op.className}, ${op.name})`, ok: true, message: `Updated XML block, ST body, ${objMap.size} network file(s)` });
              break;
            }

            case "rename_client": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              renameClientInSt(stPath, op.oldName, op.newName);
              renameClientInStBody(stPath, op.oldName, op.newName);
              const objMap = findObjectsOfClass(lcnPaths, op.className);
              for (const [lcnPath, objNames] of objMap) {
                tx.backup(lcnPath);
                touchedFiles.add(lcnPath);
                cascadeRenameClientInLcn(lcnPath, op.className, op.oldName, op.newName, objNames);
              }
              results.push({ op: `rename_client(${op.className}, ${op.oldName}→${op.newName})`, ok: true, message: `Updated XML block, ST body, ${objMap.size} network file(s)` });
              break;
            }

            case "add_variable": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              addVariableToSt(stPath, op.name, op.varType);
              results.push({ op: `add_variable(${op.className}, ${op.name}: ${op.varType})`, ok: true, message: "Added to //Variables: section" });
              break;
            }

            case "remove_variable": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              removeVariableFromSt(stPath, op.name);
              results.push({ op: `remove_variable(${op.className}, ${op.name})`, ok: true, message: "Removed from //Variables: section" });
              break;
            }

            case "rename_variable": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              const count = renameVariableInSt(stPath, op.oldName, op.newName, op.renameInBody);
              results.push({
                op: `rename_variable(${op.className}, ${op.oldName}→${op.newName})`,
                ok: true,
                message: op.renameInBody
                  ? `Renamed in declaration + ${count} occurrence(s) in method bodies`
                  : "Renamed in declaration only",
              });
              break;
            }

            case "add_method": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              addMethodToSt(stPath, op.className, {
                name: op.name,
                modifiers: op.modifiers,
                params: op.params,
                body: op.body,
              });
              results.push({ op: `add_method(${op.className}::${op.name})`, ok: true, message: "Added declaration + stub implementation" });
              break;
            }

            case "remove_method": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              removeMethodFromSt(stPath, op.className, op.name);
              results.push({ op: `remove_method(${op.className}::${op.name})`, ok: true, message: "Removed declaration + implementation" });
              break;
            }

            case "rename_method": {
              const stPath = findStForClass(lcpInfo.classFiles, op.className);
              if (!stPath) throw new Error(`Class "${op.className}" not found in project`);
              tx.backup(stPath);
              touchedFiles.add(stPath);

              renameMethodInSt(stPath, op.className, op.oldName, op.newName);
              results.push({ op: `rename_method(${op.className}::${op.oldName}→${op.newName})`, ok: true, message: "Renamed declaration header + implementation header" });
              break;
            }
          }
        }

        // Post-edit parsing validation
        for (const file of touchedFiles) {
          try {
            if (file.endsWith(".st")) {
              parseStClass(file);
            } else if (file.endsWith(".lcn")) {
              parseLcn(file);
            }
          } catch (e: any) {
            throw new Error(`Validation failed for ${basename(file)}: ${e.message}`);
          }
        }

        // Optional post-edit compilation check
        if (args.validate_compile) {
          const br = await runBatchOps(resolved.path, [{ type: "compile", optionName: "BuildChanges" }]);
          if (!br.ok) {
            throw new Error(`Compilation check failed: ${br.errors.join("; ")}`);
          }
        }

        tx.commit();
      } catch (e: any) {
        const rollbackInfo = tx.rollback();
        return respond({
          ok: false,
          error: e.message,
          rolledBack: true,
          restored: rollbackInfo.restored.map(f => basename(f)),
          hints: ["Correct the operation data or syntax errors in the class files and try again."]
        });
      }
    } else {
      // Batch-only operations
      for (const op of ops) {
        switch (op.type) {
          case "create_network":
            batchOps.push({ type: "create_network", name: op.name });
            results.push({ op: `create_network(${op.name})`, ok: true, message: "Queued for batch" });
            break;
          case "delete_network":
            batchOps.push({ type: "delete_network", name: op.name, deleteConnections: op.deleteConnections });
            results.push({ op: `delete_network(${op.name})`, ok: true, message: "Queued for batch" });
            break;
          case "rename_network":
            batchOps.push({ type: "rename_network", oldName: op.oldName, newName: op.newName });
            results.push({ op: `rename_network(${op.oldName}→${op.newName})`, ok: true, message: "Queued for batch" });
            break;
          case "duplicate_network":
            batchOps.push({ type: "duplicate_network", name: op.name, newName: op.newName });
            results.push({ op: `duplicate_network(${op.name}→${op.newName})`, ok: true, message: "Queued for batch" });
            break;
          case "add_object":
            batchOps.push({
              type: "add_object",
              network: op.network,
              className: op.className,
              objectName: op.objectName,
              x: op.x,
              y: op.y,
              visualized: op.visualized,
            });
            results.push({ op: `add_object(${op.network}, ${op.objectName}:${op.className})`, ok: true, message: "Queued for batch" });
            break;
          case "remove_object":
            batchOps.push({
              type: "remove_object",
              network: op.network,
              objectName: op.objectName,
              deleteConnections: op.deleteConnections,
            });
            results.push({ op: `remove_object(${op.network}, ${op.objectName})`, ok: true, message: "Queued for batch" });
            break;
          case "rename_object":
            batchOps.push({ type: "rename_object", network: op.network, oldName: op.oldName, newName: op.newName });
            results.push({ op: `rename_object(${op.network}, ${op.oldName}→${op.newName})`, ok: true, message: "Queued for batch" });
            break;
          case "change_object_class":
            batchOps.push({ type: "change_object_class", network: op.network, objectName: op.objectName, className: op.className });
            results.push({ op: `change_object_class(${op.objectName}→${op.className})`, ok: true, message: "Queued for batch" });
            break;
          case "create_connection":
            batchOps.push({
              type: "create_connection",
              network: op.network,
              fromObject: op.fromObject,
              fromClient: op.fromClient,
              toObject: op.toObject,
              toServer: op.toServer,
            });
            results.push({ op: `create_connection(${op.fromObject}.${op.fromClient}→${op.toObject}.${op.toServer})`, ok: true, message: "Queued for batch" });
            break;
          case "delete_connection":
            batchOps.push({ type: "delete_connection", network: op.network, objectName: op.objectName, clientName: op.clientName });
            results.push({ op: `delete_connection(${op.objectName}.${op.clientName})`, ok: true, message: "Queued for batch" });
            break;
          case "set_init_value":
            batchOps.push({
              type: "set_init_value",
              network: op.network,
              objectName: op.objectName,
              channelName: op.channelName,
              value: op.value,
            });
            results.push({ op: `set_init_value(${op.objectName}.${op.channelName}=${op.value})`, ok: true, message: "Queued for batch" });
            break;
          case "delete_class":
            batchOps.push({ type: "delete_class", className: op.className, force: op.force });
            results.push({ op: `delete_class(${op.className})`, ok: true, message: "Queued for batch" });
            break;
          case "compile":
            batchOps.push({ type: "compile", optionName: op.options });
            results.push({ op: `compile(${op.options})`, ok: true, message: "Queued for batch" });
            break;
          case "download":
            batchOps.push({ type: "download", connection: op.connection ?? "", addLoaderAnyway: op.add_loader_anyway });
            results.push({ op: `download(${op.connection ?? "project connection"})`, ok: true, message: "Queued for batch" });
            break;
          case "set_task_order":
            batchOps.push({ type: "set_task_order", network: op.network, objectName: op.objectName, task: op.task, position: op.position });
            results.push({ op: `set_task_order(${op.objectName}.${op.task}=${op.position})`, ok: true, message: "Queued for batch" });
            break;
          case "set_task_time":
            batchOps.push({ type: "set_task_time", network: op.network, objectName: op.objectName, task: op.task, time: op.time });
            results.push({ op: `set_task_time(${op.objectName}.${op.task}=${op.time})`, ok: true, message: "Queued for batch" });
            break;
          case "set_task_cpu_core":
            batchOps.push({ type: "set_task_cpu_core", network: op.network, objectName: op.objectName, task: op.task, core: op.core });
            results.push({ op: `set_task_cpu_core(${op.objectName}.${op.task}=core${op.core})`, ok: true, message: "Queued for batch" });
            break;
          case "set_multi_cpu_core":
            batchOps.push({ type: "set_multi_cpu_core", multiCore: op.multiCore });
            results.push({ op: `set_multi_cpu_core(${op.multiCore})`, ok: true, message: "Queued for batch" });
            break;
          case "set_visualized_flag":
            batchOps.push({ type: "set_visualized_flag", network: op.network, objectName: op.objectName, isVisualized: op.isVisualized });
            results.push({ op: `set_visualized_flag(${op.objectName}=${op.isVisualized})`, ok: true, message: "Queued for batch" });
            break;
          case "set_comment_network":
            batchOps.push({ type: "set_comment_network", network: op.network, comment: op.comment });
            results.push({ op: `set_comment_network(${op.network})`, ok: true, message: "Queued for batch" });
            break;
          case "set_comment_object":
            batchOps.push({ type: "set_comment_object", network: op.network, objectName: op.objectName, comment: op.comment });
            results.push({ op: `set_comment_object(${op.objectName})`, ok: true, message: "Queued for batch" });
            break;
          case "set_network_options":
            batchOps.push({ type: "set_network_options", network: op.network, optionNames: op.optionNames, resetAllOthers: op.resetAllOthers });
            results.push({ op: `set_network_options(${op.network}, [${op.optionNames.join(",")}])`, ok: true, message: "Queued for batch" });
            break;
          case "reset_network_options":
            batchOps.push({ type: "reset_network_options", network: op.network, optionNames: op.optionNames });
            results.push({ op: `reset_network_options(${op.network}, [${op.optionNames.join(",")}])`, ok: true, message: "Queued for batch" });
            break;
          case "move_network_to_folder":
            batchOps.push({ type: "move_network_to_folder", network: op.network, folder: op.folder });
            results.push({ op: `move_network_to_folder(${op.network} → ${op.folder})`, ok: true, message: "Queued for batch" });
            break;
          case "set_parameter_value":
            batchOps.push({ type: "set_parameter_value", network: op.network, objectName: op.objectName, parameterName: op.parameterName, value: op.value });
            results.push({ op: `set_parameter_value(${op.objectName}.${op.parameterName}=${op.value})`, ok: true, message: "Queued for batch" });
            break;
        }
      }

      let batchResult: Record<string, unknown> | null = null;
      if (batchOps.length > 0) {
        const br = await runBatchOps(resolved.path, batchOps);
        batchResult = {
          ok: br.ok,
          exitCode: br.exitCode,
          durationMs: br.durationMs,
          errors: br.errors,
          warnings: br.warnings,
          logPath: br.logPath,
        };
        if (!br.ok) {
          for (const r of results) {
            if (r.message === "Queued for batch") {
              r.ok = false;
              r.message = "Batch script failed — see batchResult.errors";
            }
          }
        } else {
          for (const r of results) {
            if (r.message === "Queued for batch") {
              r.message = "Applied via batch";
            }
          }
        }
      }

      const overallOk = results.every((r) => r.ok) && (batchResult === null || batchResult.ok);
      const output: Record<string, unknown> = {
        ok: overallOk,
        operations: results,
      };
      if (batchResult) output.batchResult = batchResult;

      return respond(output as any);
    }

    const overallOk = results.every((r) => r.ok);
    return respond({
      ok: overallOk,
      operations: results
    });
  });
}
