import { z } from "zod";
import { fromToolResponse } from "../../core/actions/legacy.js";
import { defineAction } from "../../core/actions/types.js";
import { applyProjectChangesHandler, applyProjectChangesSchema } from "../../tools/applyProjectChanges.js";
import { createBootdiskHandler, createBootdiskSchema } from "../../tools/createBootdisk.js";
import { inspectProjectHandler } from "../../tools/inspectProject.js";
import { manageClass2Handler } from "../../tools/lasalApps.js";
import { buildProjectHandler, controlPlcHandler, plcValuesHandler } from "../../tools/plcControl.js";
import { plcDiagnosticsHandler } from "../../tools/plcDiagnostics.js";
import { classSourceHandler } from "../../tools/readClassSource.js";
import { runClass2ScriptHandler } from "../../tools/runClass2Script.js";
import { runGuidValidation } from "../../tools/validateGuids.js";
import { resolveLcpPath } from "../../utils/resolvePaths.js";

const lcpPath = z.string().optional().describe("Absolute path to the .lcp file. Omit to use the selected project.");
const connection = z
  .string()
  .optional()
  .describe("Connection string or address-book name. Omit to use the project's saved connection.");

function fromApply(lcp_path: string | undefined, operations: unknown[]) {
  return applyProjectChangesHandler({ lcp_path, operations });
}

export const class2Actions = [
  defineAction({
    id: "class2.project.inspect",
    aliases: ["inspect_project", "inspect_class2"],
    domain: "class2",
    summary: "Read the CLASS 2 project inventory: classes, channels, tasks, networks and objects.",
    schema: z.object({
      lcp_path: lcpPath,
      class_names: z.array(z.string()).optional().describe("Limit full channel details to these class names."),
      include_networks: z.boolean().optional().default(false).describe("Include network objects."),
      include_connections: z.boolean().optional().default(false).describe("Include network connections."),
    }),
    handler: async (params) => fromToolResponse(await inspectProjectHandler(params)),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "project", "inspect", "classes", "networks"],
    examples: [
      { params: {}, note: "Summarize all classes." },
      { params: { include_networks: true, include_connections: true }, note: "Include networks and connections." },
    ],
  }),

  defineAction({
    id: "class2.class.read_source",
    aliases: ["read_class_source", "read_st"],
    domain: "class2",
    summary: "Read a CLASS 2 class source (.st) by class name, optionally including the .h file.",
    schema: z.object({
      class_name: z.string().describe("Class name, e.g. 'Motor'."),
      lcp_path: lcpPath,
      include_header: z.boolean().optional().default(false).describe("Also return the .h file content."),
    }),
    handler: async (params) => fromToolResponse(await classSourceHandler({ action: "read", ...params })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "class", "source", "st", "read"],
    examples: [{ params: { class_name: "Motor" }, note: "Read a class source." }],
  }),

  defineAction({
    id: "class2.class.write_source",
    aliases: ["write_class_source", "write_st"],
    domain: "class2",
    summary: "Overwrite a CLASS 2 class source (.st), optionally updating its .h file.",
    schema: z.object({
      class_name: z.string().describe("Class name, e.g. 'Motor'."),
      lcp_path: lcpPath,
      source: z.string().describe("Full latin1-compatible .st content."),
      header_source: z.string().optional().describe("Optional .h content. Omit to leave the header unchanged."),
      expected_stamp: z
        .object({ mtimeMs: z.number(), size: z.number() })
        .optional()
        .describe("Stamp returned by class2.class.read_source. Rejects the write if the file changed."),
    }),
    handler: async (params) => fromToolResponse(await classSourceHandler({ action: "write", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "class", "source", "st", "write"],
    examples: [
      {
        params: { class_name: "Motor", source: "//{{LSL_DECLARATION\n...\n//}}LSL_DECLARATION\n" },
        note: "Replace a class source. Keep the generated regions intact.",
      },
    ],
    hints: ["The CLASS 2 IDE must be closed. The write is latin1-validated and backed up for rollback."],
  }),

  defineAction({
    id: "class2.build.compile",
    aliases: ["build_project", "compile", "compile_plc"],
    domain: "class2",
    summary: "Compile the CLASS 2 project.",
    schema: z.object({
      lcp_path: lcpPath,
      options: z
        .enum(["RebuildAll", "BuildChanges", "UserClassesOnly", "NoDebugInfo"])
        .optional()
        .default("RebuildAll")
        .describe("Compile mode."),
      timeout_s: z.number().int().positive().optional().describe("Compile timeout in seconds."),
    }),
    handler: async (params) => fromToolResponse(await buildProjectHandler({ action: "compile", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["class2", "build", "compile", "engine"],
    examples: [
      { params: {}, note: "Full rebuild." },
      { params: { options: "BuildChanges" }, note: "Incremental build." },
    ],
    hints: ["Closes this project's CLASS 2 IDE before compiling."],
  }),

  defineAction({
    id: "class2.build.download",
    aliases: ["download_plc", "download_project"],
    domain: "class2",
    summary: "Download the compiled CLASS 2 project to a PLC or LARS instance.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      add_loader_anyway: z.boolean().optional().describe("Force the loader download. Default: auto for LARS/loopback."),
      timeout_s: z.number().int().positive().optional().describe("Download timeout in seconds."),
    }),
    handler: async (params) => fromToolResponse(await buildProjectHandler({ action: "download", ...params })),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["class2", "build", "download", "deploy", "plc"],
    examples: [{ params: {}, note: "Download using the station's saved connection." }],
    hints: ["Pings the PLC before downloading and retries one transient connection failure."],
  }),

  defineAction({
    id: "class2.plc.state",
    aliases: ["plc_state", "control_plc_state"],
    domain: "class2",
    summary: "Query the PLC runtime state.",
    schema: z.object({ lcp_path: lcpPath, connection }),
    handler: async (params) => fromToolResponse(await controlPlcHandler({ action: "get_state", ...params })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "plc", "state", "runtime"],
    examples: [{ params: {}, note: "Query the state of the selected project's PLC." }],
  }),

  defineAction({
    id: "class2.plc.start",
    aliases: ["plc_start", "start_plc"],
    domain: "class2",
    summary: "Start the PLC runtime.",
    schema: z.object({ lcp_path: lcpPath, connection }),
    handler: async (params) => fromToolResponse(await controlPlcHandler({ action: "start", ...params })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    tags: ["class2", "plc", "start", "runtime"],
    examples: [{ params: {}, note: "Start the PLC using the saved connection." }],
  }),

  defineAction({
    id: "class2.plc.stop",
    aliases: ["plc_stop", "stop_plc"],
    domain: "class2",
    summary: "Stop the PLC runtime.",
    schema: z.object({ lcp_path: lcpPath, connection }),
    handler: async (params) => fromToolResponse(await controlPlcHandler({ action: "stop", ...params })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    tags: ["class2", "plc", "stop", "runtime"],
    examples: [{ params: {}, note: "Stop the PLC using the saved connection." }],
  }),

  defineAction({
    id: "class2.plc.values.read",
    aliases: ["plc_values_read", "read_plc_values"],
    domain: "class2",
    summary: "Read live channel values from a running PLC.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      channels: z.array(z.string()).min(1).describe("Channels in 'ObjectName.ChannelName' format."),
    }),
    handler: async (params) => fromToolResponse(await plcValuesHandler({ action: "read", ...params })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "plc", "values", "read", "channels"],
    examples: [{ params: { channels: ["Motor1.s_Speed"] }, note: "Read one live channel." }],
  }),

  defineAction({
    id: "class2.plc.values.write",
    aliases: ["plc_values_write", "write_plc_values"],
    domain: "class2",
    summary: "Write live channel values to a running PLC.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      values: z
        .array(z.object({ channel: z.string(), value: z.string() }))
        .min(1)
        .describe("Channel/value pairs in 'ObjectName.ChannelName' format."),
    }),
    handler: async (params) => fromToolResponse(await plcValuesHandler({ action: "write", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "plc", "values", "write", "channels"],
    examples: [{ params: { values: [{ channel: "Motor1.s_Speed", value: "1200" }] }, note: "Set a channel." }],
    hints: ["Writing live values can affect running machinery. Use a test PLC/LARS instance first."],
  }),

  defineAction({
    id: "class2.changes.apply",
    aliases: ["apply_project_changes", "class2_apply"],
    domain: "class2",
    summary: "Apply an ordered list of CLASS 2 structural operations through the batch engine.",
    description:
      "Escape hatch for network/object/connection/task/class operations that need the CLASS 2 engine. " +
      "Prefer the granular actions when they exist; use this for advanced or multi-step changes.",
    schema: z.object({
      lcp_path: applyProjectChangesSchema.lcp_path,
      operations: applyProjectChangesSchema.operations,
      dry_run: applyProjectChangesSchema.dry_run,
    }),
    handler: async (params, ctx) =>
      fromToolResponse(
        await applyProjectChangesHandler({
          ...params,
          dry_run: ctx.dryRun || params.dry_run === true,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    dryRunSupported: true,
    tags: ["class2", "engine", "network", "object", "connection", "apply"],
    examples: [
      {
        params: { operations: [{ type: "create_network", name: "Main" }] },
        note: "Create a network through the batch engine.",
      },
    ],
  }),

  defineAction({
    id: "class2.network.create",
    aliases: ["create_network"],
    domain: "class2",
    summary: "Create a CLASS 2 network.",
    schema: z.object({ lcp_path: lcpPath, name: z.string().describe("Network name.") }),
    handler: async (params) =>
      fromToolResponse(await fromApply(params.lcp_path, [{ type: "create_network", name: params.name }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "network", "create"],
    examples: [{ params: { name: "Main" }, note: "Create the Main network." }],
  }),

  defineAction({
    id: "class2.object.add",
    aliases: ["add_object"],
    domain: "class2",
    summary: "Add a class instance to a CLASS 2 network.",
    schema: z.object({
      lcp_path: lcpPath,
      network: z.string().describe("Network name."),
      className: z.string().describe("Class name to instantiate."),
      objectName: z.string().describe("New object name."),
      x: z.number().optional().default(300).describe("Canvas X coordinate."),
      y: z.number().optional().default(300).describe("Canvas Y coordinate."),
      visualized: z.boolean().optional().default(true).describe("Mark the object as visualized."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await fromApply(params.lcp_path, [
          {
            type: "add_object",
            network: params.network,
            className: params.className,
            objectName: params.objectName,
            x: params.x,
            y: params.y,
            visualized: params.visualized,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "object", "add", "network"],
    examples: [
      {
        params: { network: "Main", className: "Motor", objectName: "Motor1" },
        note: "Add a Motor instance named Motor1.",
      },
    ],
  }),

  defineAction({
    id: "class2.connection.create",
    aliases: ["create_connection"],
    domain: "class2",
    summary: "Connect a client channel to a server channel.",
    schema: z.object({
      lcp_path: lcpPath,
      network: z.string().optional().describe("Network name, when the objects are in a specific network."),
      fromObject: z.string().describe("Source object name."),
      fromClient: z.string().describe("Source client channel."),
      toObject: z.string().describe("Target object name."),
      toServer: z.string().describe("Target server channel."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await fromApply(params.lcp_path, [
          {
            type: "create_connection",
            ...(params.network ? { network: params.network } : {}),
            fromObject: params.fromObject,
            fromClient: params.fromClient,
            toObject: params.toObject,
            toServer: params.toServer,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "connection", "create", "network"],
    examples: [
      {
        params: {
          fromObject: "Sensor1",
          fromClient: "c_Speed",
          toObject: "Motor1",
          toServer: "s_Speed",
        },
        note: "Connect Sensor1.c_Speed to Motor1.s_Speed.",
      },
    ],
  }),

  defineAction({
    id: "class2.class.create",
    aliases: ["create_class"],
    domain: "class2",
    summary: "Create a new CLASS 2 class with the standard generated regions.",
    schema: z.object({
      lcp_path: lcpPath,
      name: z.string().describe("Class name."),
      folder: z.string().optional().default("IQ").describe("Class browser folder."),
      revision: z.string().optional().default("0.1").describe("Class revision."),
      cyclicTask: z.boolean().optional().default(false).describe("Add a cyclic task."),
      realtimeTask: z.boolean().optional().default(false).describe("Add a realtime task."),
      backgroundTask: z.boolean().optional().default(false).describe("Add a background task."),
      defCyclicTime: z.string().optional().default("1 ms").describe("Default cyclic time."),
      defBackgroundTime: z.string().optional().default("100 ms").describe("Default background time."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await fromApply(params.lcp_path, [
          {
            type: "create_class",
            name: params.name,
            folder: params.folder,
            revision: params.revision,
            cyclicTask: params.cyclicTask,
            realtimeTask: params.realtimeTask,
            backgroundTask: params.backgroundTask,
            defCyclicTime: params.defCyclicTime,
            defBackgroundTime: params.defBackgroundTime,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "class", "create", "template"],
    examples: [{ params: { name: "Motor" }, note: "Create a Motor class with default settings." }],
  }),

  defineAction({
    id: "class2.project.file.add",
    aliases: ["add_project_file"],
    domain: "class2",
    summary: "Register an existing file in the CLASS 2 project manifest.",
    schema: z.object({
      lcp_path: lcpPath,
      path: z.string().describe("File to register, relative to the project or absolute."),
      header: z.boolean().optional().describe("Force registration in <HeaderFiles>."),
      global: z.boolean().optional().default(false).describe("Mark the header Global=true."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await fromApply(params.lcp_path, [
          {
            type: "add_project_file",
            path: params.path,
            ...(params.header !== undefined ? { header: params.header } : {}),
            global: params.global,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "project", "file", "manifest"],
    examples: [{ params: { path: "Class/Motor/C_Motor.cpp" }, note: "Register a C++ dependency file." }],
  }),

  defineAction({
    id: "class2.project.clean",
    aliases: ["clean_project"],
    domain: "class2",
    summary: "Clear CLASS 2 project caches or generated build artifacts.",
    schema: z.object({
      lcp_path: lcpPath,
      caches: z.boolean().optional().default(true).describe("Delete BrowserInfo.bin and LobInfo.bin."),
      deep: z.boolean().optional().default(false).describe("Also delete generated .lcb/Network artifacts."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await fromApply(params.lcp_path, [
          {
            type: "clean_project",
            caches: params.caches,
            deep: params.deep,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "project", "clean", "cache", "artifacts"],
    examples: [{ params: {}, note: "Clear project caches." }],
  }),

  defineAction({
    id: "class2.guid.validate",
    aliases: ["validate_guids", "validate_guid"],
    domain: "class2",
    summary: "Scan classes for duplicate GUIDs and uninitialized @CT_ CRC hashes, optionally fixing them.",
    schema: z.object({
      lcp_path: lcpPath,
      auto_fix: z.boolean().optional().default(false).describe("Repair duplicate GUIDs and populate CRC hashes."),
    }),
    handler: async (params) => {
      const resolved = resolveLcpPath(params.lcp_path);
      if ("error" in resolved) {
        return { ok: false, error: { code: "PRECONDITION_FAILED", message: resolved.error } };
      }
      const result = runGuidValidation(resolved.path, params.auto_fix === true);
      return {
        ok: true,
        data: result,
        ...(result.collisions.length || result.ctHashFixes.length
          ? { warnings: ["GUID collisions or @CT_ hash fixes were detected. Set auto_fix=true to repair."] }
          : {}),
      };
    },
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "guid", "crc", "ct", "validate", "repair"],
    examples: [
      { params: { auto_fix: false }, note: "Scan without modifying files." },
      { params: { auto_fix: true }, note: "Repair GUIDs and CRC hashes." },
    ],
  }),

  defineAction({
    id: "class2.script.run",
    aliases: ["run_class2_script", "class2_script"],
    domain: "class2",
    summary: "Run arbitrary Python 2.7 CLASS 2 batch statements through the IDE.",
    description:
      "Expert escape hatch. The script runs with `batch` and the loaded project `prj` in scope; call batch.Save(prj) yourself to persist changes.",
    schema: z.object({
      script_body: z.string().min(1).describe("Python 2.7 batch statements."),
      args: z.array(z.string()).optional().default([]).describe("Arguments exposed as sys.argv[1:]."),
      lcp_path: lcpPath,
    }),
    handler: async (params) => fromToolResponse(await runClass2ScriptHandler(params)),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    expert: true,
    tags: ["class2", "script", "batch", "expert", "escape-hatch"],
    examples: [{ params: { script_body: "batch.Save(prj)" }, note: "Save the loaded project." }],
    hints: ["Requires --allow-expert and top-level confirm=true."],
  }),

  defineAction({
    id: "class2.diagnostics.code_analysis",
    aliases: ["code_analysis", "analyze_code"],
    domain: "class2",
    summary: "Run the vendor's static code analysis on the project or one source file.",
    schema: z.object({
      lcp_path: lcpPath,
      source_file: z.string().optional().describe("Analyze one source file instead of the whole project."),
      output_path: z.string().optional().describe("Destination for the analysis XML."),
    }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "code_analysis", ...params })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["class2", "diagnostics", "analysis", "static", "code"],
    examples: [{ params: {}, note: "Analyze the whole project." }],
  }),

  defineAction({
    id: "class2.diagnostics.trace",
    aliases: ["plc_trace", "trace_plc"],
    domain: "class2",
    summary: "Record a DataAnalyzer trace on the PLC.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      config_path: z.string().optional().describe("DataAnalyzer configuration file."),
      duration_ms: z.number().int().positive().optional().default(5000).describe("Trace duration."),
      output_path: z.string().optional().describe("Destination for the trace output."),
    }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "trace", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["class2", "diagnostics", "trace", "plc", "dataanalyzer"],
    examples: [{ params: {}, note: "Record a 5-second trace." }],
  }),

  defineAction({
    id: "class2.diagnostics.file.upload",
    aliases: ["plc_file_upload", "upload_plc_file"],
    domain: "class2",
    summary: "Upload a local file to the PLC.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      plc_path: z.string().describe("Destination path on the PLC."),
      local_path: z.string().describe("Local source file."),
    }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "file_upload", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "diagnostics", "file", "upload", "plc"],
    examples: [{ params: { plc_path: "/cfg/app.ini", local_path: "C:\\Temp\\app.ini" }, note: "Upload a file." }],
  }),

  defineAction({
    id: "class2.diagnostics.file.download",
    aliases: ["plc_file_download", "download_plc_file"],
    domain: "class2",
    summary: "Download a file from the PLC.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      plc_path: z.string().describe("Source path on the PLC."),
      local_path: z.string().describe("Local destination file."),
    }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "file_download", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "diagnostics", "file", "download", "plc"],
    examples: [{ params: { plc_path: "/cfg/app.ini", local_path: "C:\\Temp\\app.ini" }, note: "Download a file." }],
  }),

  defineAction({
    id: "class2.diagnostics.file.delete",
    aliases: ["plc_file_delete", "delete_plc_file"],
    domain: "class2",
    summary: "Delete a file on the PLC.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      plc_path: z.string().describe("Path on the PLC to delete."),
    }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "file_delete", ...params })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    tags: ["class2", "diagnostics", "file", "delete", "plc"],
    examples: [{ params: { plc_path: "/cfg/old.ini" }, note: "Delete a file on the PLC." }],
  }),

  defineAction({
    id: "class2.diagnostics.os.download",
    aliases: ["download_os", "install_lasalos"],
    domain: "class2",
    summary: "Install a LasalOS image on the PLC. The control reboots.",
    schema: z.object({
      lcp_path: lcpPath,
      connection,
      os_path: z.string().describe("LasalOS .lbi file."),
      timeout_s: z.number().int().positive().optional().describe("Timeout in seconds."),
    }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "download_os", ...params })),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["class2", "diagnostics", "os", "download", "reboot"],
    examples: [{ params: { os_path: "C:\\Temp\\LasalOS.lbi" }, note: "Install a LasalOS image." }],
  }),

  defineAction({
    id: "class2.diagnostics.ram.clear",
    aliases: ["clear_ram_image", "clear_plc_ram"],
    domain: "class2",
    summary: "Clear the PLC RAM image.",
    schema: z.object({ lcp_path: lcpPath, connection }),
    handler: async (params) => fromToolResponse(await plcDiagnosticsHandler({ action: "clear_ram_image", ...params })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    tags: ["class2", "diagnostics", "ram", "clear", "plc"],
    examples: [{ params: {}, note: "Clear the RAM image." }],
  }),

  defineAction({
    id: "class2.diagnostics.project.backup",
    aliases: ["save_project_on_plc", "backup_plc_project"],
    domain: "class2",
    summary: "Back up the running project from the PLC.",
    schema: z.object({ lcp_path: lcpPath, connection }),
    handler: async (params) =>
      fromToolResponse(await plcDiagnosticsHandler({ action: "save_project_on_plc", ...params })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "diagnostics", "project", "backup", "plc"],
    examples: [{ params: {}, note: "Back up the running project." }],
  }),

  defineAction({
    id: "class2.editor.open",
    aliases: ["manage_class2_open", "open_class2"],
    domain: "class2",
    summary: "Open the CLASS 2 IDE for a project.",
    schema: z.object({ lcp_path: lcpPath }),
    handler: async (params) =>
      fromToolResponse(await manageClass2Handler({ action: "open", lcp_path: params.lcp_path })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["class2", "editor", "gui", "open"],
    examples: [{ params: {}, note: "Open the selected CLASS 2 project." }],
  }),

  defineAction({
    id: "class2.editor.close",
    aliases: ["manage_class2_close", "close_class2"],
    domain: "class2",
    summary: "Close CLASS 2, leaving instances opened for other projects running unless force is set.",
    schema: z.object({
      force: z.boolean().optional().default(false).describe("Close every CLASS 2 instance, including other projects."),
    }),
    handler: async (params) => fromToolResponse(await manageClass2Handler({ action: "close", force: params.force })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    tags: ["class2", "editor", "gui", "close"],
    examples: [{ params: { force: false }, note: "Close only this project's CLASS 2 instances." }],
  }),

  defineAction({
    id: "class2.bootdisk.create",
    aliases: ["create_class2_bootdisk", "create_bootdisk"],
    domain: "class2",
    summary: "Create a CLASS 2 bootdisk or update stick.",
    schema: z.object(createBootdiskSchema),
    handler: async (params) => fromToolResponse(await createBootdiskHandler(params)),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["class2", "bootdisk", "update-stick", "deploy", "usb"],
    examples: [{ params: { output_path: "E:\\" }, note: "Create a bootdisk at the root of drive E:." }],
  }),
];
