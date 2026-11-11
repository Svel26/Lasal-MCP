import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { z } from "zod";
import { defineAction, type ActionResult } from "../../core/actions/types.js";
import { ensureScratch } from "../../core/scratch.js";
import { isPidRunning } from "../../core/process.js";
import { readState } from "../../state.js";
import { SCRATCH } from "../../utils/engine.js";
import { fromToolResponse } from "../../core/actions/legacy.js";
import type { ToolResponse } from "../../utils/respond.js";
import {
  LARS_EXE,
  cloneLarsWorkspace,
  createLarsWorkspace,
  extractWorkspaceBlock,
  getLarsPids,
  isLarsHealthy,
  larsConfigPath,
  mergeLarsConfigRaw,
  parseLarsConfig,
  readLarsConfigRaw,
  readLarsWorkspaces,
  validateLarsWorkspaces,
  wrapWorkspaceExport,
  writeLarsConfigRaw,
  type ParsedLarsConfig,
} from "../../utils/lars.js";
import { larsRuntimeHandler } from "../../tools/larsRuntime.js";

const port = z.number().int().min(1).max(65535);
const workspaceName = z.string().min(1).describe("LARS workspace name.");
const projectDir = z.string().optional().describe("Solution directory. Omit to use the selected project.");

const workspaceConfigShape = {
  onlinePort: port.optional().describe("Configured ONLINE port. Omit to allocate the next free port."),
  comlinkServerPort: port.optional().describe("Comlink command-server port."),
  comlinkBasePort: port.optional().describe("Base port used for clients."),
  alarmPort: port.optional().describe("Alarm-server port."),
  dataServiceTcpPort: port.optional().describe("DataService/datalink TCP port (2402 is reserved for the HMI)."),
  activeData: z.string().optional().describe("Emulated active-data path, usually C:\\."),
  autoexec: z.string().optional().describe("Emulated autoexec path, usually C:\\Autoexec.lsl."),
  lslWork: z.string().optional().describe("Emulated LSLWORK path."),
  sramData: z.string().optional().describe("Emulated SRAM data path."),
  screenProjectPath: z.string().optional().describe("Host path to the .lpr project LARS should render."),
  dataRoot: z.string().optional().describe("Isolated host folder mapped to the emulated C: drive."),
  driveMaps: z
    .array(z.object({ drive: z.string(), path: z.string() }))
    .optional()
    .describe("Additional drive mappings (D:, E:, ...). C: is controlled by dataRoot."),
  dataLenMb: z.number().int().positive().optional().describe("Data memory size in MiB."),
  codeLenMb: z.number().int().positive().optional().describe("Code memory size in MiB."),
};

function failure(code: string, message: string, hints?: string[]): ActionResult {
  return { ok: false, error: { code, message }, ...(hints ? { hints } : {}) };
}

function configParseFailure(error: string): ActionResult {
  return failure("PRECONDITION_FAILED", error, ["Check LASAL_LARS_CONFIG and run lars.doctor."]);
}

function toolData(response: ToolResponse): Record<string, unknown> {
  const text = response.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { value: text };
  }
}

type WorkspaceValidationResult =
  { error: string } | { raw: string; config: ParsedLarsConfig; errors: string[]; warnings: string[] };

function workspaceValidation(name: string | undefined): WorkspaceValidationResult {
  const raw = readLarsConfigRaw();
  if (raw === undefined) return { error: `LARS config not found at ${larsConfigPath()}.` };
  const parsed = parseLarsConfig(raw);
  if (!parsed.ok) return { error: parsed.error };
  const all = validateLarsWorkspaces(parsed.config.workspaces);
  const suffix = name ? `'${name}'` : undefined;
  return {
    raw,
    config: parsed.config,
    errors: suffix ? all.errors.filter((issue) => issue.includes(suffix)) : all.errors,
    warnings: suffix ? all.warnings.filter((issue) => issue.includes(suffix)) : all.warnings,
  };
}

async function runtimeSummary(name: string, configuredOnlinePort?: number) {
  const state = readState();
  const instance = state.larsInstances?.[name];
  const pids = getLarsPids(name);
  const running = pids.length > 0;
  const effectiveOnlinePort = instance?.effectiveOnlinePort;
  const healthy = running
    ? await isLarsHealthy(effectiveOnlinePort ?? configuredOnlinePort ?? instance?.onlinePort ?? 0)
    : false;
  return {
    running,
    ...((pids[0] ?? instance?.pid) ? { pid: pids[0] ?? instance?.pid } : {}),
    ...(effectiveOnlinePort !== undefined ? { effectiveOnlinePort } : {}),
    healthy,
    stationName: instance?.stationName ?? null,
    stationId: instance?.stationId ?? null,
    lcpPath: instance?.lcpPath ?? null,
    lssPath: instance?.stationLssPath ?? null,
    projectDir: instance?.projectDir ?? null,
    role: instance?.role ?? null,
    targetedAtLars: instance?.stationTargetOverridden ?? Boolean(instance?.originalIp),
  };
}

export const larsConfigActions = [
  defineAction({
    id: "lars.workspace.get",
    aliases: ["lars_get_workspace", "lars_workspace_show"],
    domain: "lars",
    summary: "Read one LARS workspace, its raw XML block, validation issues and runtime state.",
    schema: z.object({ name: workspaceName }),
    handler: async (params) => {
      const checked = workspaceValidation(params.name);
      if ("error" in checked) return configParseFailure(checked.error);
      const workspace = checked.config.workspaces.find((candidate) => candidate.name === params.name);
      if (!workspace) {
        return failure("PRECONDITION_FAILED", `No LARS workspace named '${params.name}'.`, [
          "Run lars.workspace.list to see configured workspaces.",
        ]);
      }
      const block = extractWorkspaceBlock(checked.raw, params.name);
      return {
        ok: true,
        data: {
          workspace,
          rawXml: block ?? null,
          configVersion: checked.config.configVersion ?? "2",
          validation: { errors: checked.errors, warnings: checked.warnings },
          runtime: await runtimeSummary(params.name, workspace.onlinePort),
        },
      };
    },
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "workspace", "get", "inspect", "config", "xml"],
    examples: [{ params: { name: "MyProject_PLC" }, note: "Inspect one workspace and its raw config block." }],
  }),

  defineAction({
    id: "lars.workspace.create",
    aliases: ["lars_create_workspace", "lars_workspace_add"],
    domain: "lars",
    summary: "Create one LARS workspace with allocated ports and an isolated data root.",
    description:
      "Unlike lars.workspace.setup, this creates exactly one workspace and never touches existing ones. " +
      "Omitted ports are allocated; explicit ports are validated against every configured workspace.",
    schema: z.object({ name: workspaceName, ...workspaceConfigShape }),
    handler: async (params) => {
      const { name, ...partial } = params;
      const result = createLarsWorkspace(name, partial);
      if (result.error || !result.workspace) {
        return failure("INVALID_PARAMS", result.error ?? "Could not create the workspace.", result.errors);
      }
      return {
        ok: true,
        data: { workspace: result.workspace, warnings: result.warnings },
        hints: ["Start it with lars.instance.start, then point the station at it with lars.station.target."],
      };
    },
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    idempotent: false,
    tags: ["lars", "workspace", "create", "add", "config", "ports"],
    examples: [
      { params: { name: "MyProject_PLC" }, note: "Create a workspace with the next free port block." },
      {
        params: { name: "MyProject_HMI", dataServiceTcpPort: 2402, dataLenMb: 64 },
        note: "Create the HMI workspace that owns the DataService port.",
      },
    ],
  }),

  defineAction({
    id: "lars.workspace.clone",
    aliases: ["lars_clone_workspace", "lars_workspace_copy"],
    domain: "lars",
    summary: "Clone a LARS workspace under a new name with new ports and an isolated data root.",
    description:
      "Copies paths, memory sizes and drive mappings, but never reuses the source ports or data root. " +
      "This is the safe way to prepare a second station from an existing configuration.",
    schema: z.object({
      source: z.string().min(1).describe("Existing workspace to copy."),
      name: workspaceName.describe("New workspace name."),
      ...workspaceConfigShape,
    }),
    handler: async (params) => {
      const { source, name, ...partial } = params;
      const result = cloneLarsWorkspace(source, name, partial);
      if (result.error || !result.workspace) {
        return failure("INVALID_PARAMS", result.error ?? "Could not clone the workspace.", result.errors);
      }
      return {
        ok: true,
        data: { source, workspace: result.workspace, warnings: result.warnings },
        hints: ["Review the allocated ports and dataRoot before starting the clone."],
      };
    },
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    idempotent: false,
    tags: ["lars", "workspace", "clone", "copy", "config", "ports"],
    examples: [
      {
        params: { source: "MyProject_PLC", name: "MyProject_PLC_Test" },
        note: "Clone a workspace for a parallel test instance.",
      },
    ],
  }),

  defineAction({
    id: "lars.workspace.validate",
    aliases: ["lars_validate_workspace", "lars_workspace_check"],
    domain: "lars",
    summary: "Validate LARS workspace config: ports, data roots, drive maps, memory and runtime state.",
    schema: z.object({
      name: z.string().optional().describe("Validate one workspace. Omit to validate every workspace."),
    }),
    handler: async (params) => {
      const checked = workspaceValidation(params.name);
      if ("error" in checked) return configParseFailure(checked.error);
      if (params.name && !checked.config.workspaceNames.includes(params.name)) {
        return failure("PRECONDITION_FAILED", `No LARS workspace named '${params.name}'.`, [
          `Configured workspaces: ${checked.config.workspaceNames.join(", ") || "(none)"}.`,
        ]);
      }
      const state = readState();
      const runtimeIssues: string[] = [];
      for (const [name, instance] of Object.entries(state.larsInstances ?? {})) {
        if (!checked.config.workspaceNames.includes(name)) {
          runtimeIssues.push(`Runtime instance '${name}' has no workspace config.`);
        }
        if (instance.pid && !isPidRunning(instance.pid)) {
          runtimeIssues.push(`Runtime instance '${name}' records PID ${instance.pid}, which is not running.`);
        }
      }
      const errors = [...checked.errors];
      return {
        ok: true,
        data: {
          valid: errors.length === 0,
          errors,
          warnings: checked.warnings,
          runtimeIssues,
          configVersion: checked.config.configVersion ?? "2",
          workspaces: checked.config.workspaceNames,
          unknownElements: checked.config.unknownElements,
        },
        ...(errors.length === 0 ? {} : { hints: ["Fix errors before starting or updating a workspace."] }),
      };
    },
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "workspace", "validate", "doctor", "ports", "config"],
    examples: [
      { params: {}, note: "Validate every configured workspace." },
      { params: { name: "MyProject_PLC" }, note: "Validate one workspace." },
    ],
  }),

  defineAction({
    id: "lars.workspace.export",
    aliases: ["lars_export_workspace", "lars_export_config"],
    domain: "lars",
    summary: "Export the LARS config, or one workspace, as lossless XML or modeled JSON.",
    description:
      "XML export preserves fields this server does not model, so it can be archived and imported again. " +
      "JSON export contains the modeled workspace fields only.",
    schema: z.object({
      workspace: z.string().optional().describe("Export one workspace. Omit to export the whole config."),
      format: z.enum(["xml", "json"]).optional().default("xml").describe("Output format. Default xml."),
      output_path: z.string().optional().describe("Destination file. Defaults to a file under the MCP scratch folder."),
    }),
    handler: async (params) => {
      const raw = readLarsConfigRaw();
      if (raw === undefined) return configParseFailure(`LARS config not found at ${larsConfigPath()}.`);
      const parsed = parseLarsConfig(raw);
      if (!parsed.ok) return configParseFailure(parsed.error);
      if (params.workspace && !parsed.config.workspaceNames.includes(params.workspace)) {
        return failure("PRECONDITION_FAILED", `No LARS workspace named '${params.workspace}'.`, [
          `Configured workspaces: ${parsed.config.workspaceNames.join(", ") || "(none)"}.`,
        ]);
      }

      let content: string;
      const format = params.format ?? "xml";
      if (format === "xml") {
        if (params.workspace) {
          const block = extractWorkspaceBlock(raw, params.workspace);
          if (!block) return failure("PRECONDITION_FAILED", `Could not extract workspace '${params.workspace}'.`);
          content = wrapWorkspaceExport(block, parsed.config.configVersion ?? "2");
        } else {
          content = raw;
        }
      } else {
        const workspaces = params.workspace
          ? parsed.config.workspaces.filter((workspace) => workspace.name === params.workspace)
          : parsed.config.workspaces;
        content = JSON.stringify({ configVersion: parsed.config.configVersion ?? "2", workspaces }, null, 2);
      }

      ensureScratch();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputPath =
        params.output_path ??
        join(SCRATCH, `lars-export-${params.workspace ?? "all"}-${stamp}.${format === "xml" ? "xml" : "json"}`);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, content, "utf-8");
      const bytes = statSync(outputPath).size;
      const sha256 = createHash("sha256").update(content, "utf-8").digest("hex");
      return {
        ok: true,
        data: {
          outputPath,
          format,
          bytes,
          sha256,
          workspaces: params.workspace ? [params.workspace] : parsed.config.workspaceNames,
          preview: content.slice(0, 2000),
        },
        artifacts: [{ name: basename(outputPath), path: outputPath, kind: `lars-config-${format}` }],
      };
    },
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    idempotent: true,
    tags: ["lars", "workspace", "export", "config", "backup", "xml", "json"],
    examples: [
      { params: {}, note: "Export the complete config as lossless XML." },
      { params: { workspace: "MyProject_PLC", format: "json" }, note: "Export one workspace as modeled JSON." },
    ],
  }),

  defineAction({
    id: "lars.workspace.import",
    aliases: ["lars_import_workspace", "lars_import_config", "lars_restore_config"],
    domain: "lars",
    summary: "Import a LARS config or workspace file, merging by default or replacing with confirmation.",
    description:
      "Validates the imported file before writing and keeps a .bak of the previous config. " +
      "mode=merge replaces workspace blocks with the same name and appends new ones; unrelated config stays untouched. " +
      "mode=replace overwrites the whole file and requires confirm=true.",
    schema: z.object({
      input_path: z.string().min(1).describe("XML file previously produced by lars.workspace.export."),
      mode: z.enum(["merge", "replace"]).optional().default("merge").describe("Default merge."),
    }),
    handler: async (params, ctx) => {
      if (!existsSync(params.input_path)) {
        return failure("INVALID_PARAMS", `Input file not found: ${params.input_path}`);
      }
      let importedRaw: string;
      try {
        importedRaw = readFileSync(params.input_path, "utf-8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure("INVALID_PARAMS", `Could not read ${params.input_path}: ${message}`);
      }

      const imported = parseLarsConfig(importedRaw);
      if (!imported.ok) return configParseFailure(imported.error);
      if (imported.config.unnamedWorkspaceBlocks > 0) {
        return failure("INVALID_PARAMS", "The imported file contains WORKSPACE blocks without a Name attribute.");
      }
      if (imported.config.workspaces.length === 0) {
        return failure("INVALID_PARAMS", "The imported file contains no workspaces.");
      }
      const validation = validateLarsWorkspaces(imported.config.workspaces);
      if (validation.errors.length > 0) {
        return failure("INVALID_PARAMS", validation.errors[0]!, validation.errors);
      }

      const mode = params.mode ?? "merge";
      if (mode === "replace" && !ctx.confirm) {
        return failure("CONFIRM_REQUIRED", "mode=replace overwrites the whole LARS config.", [
          "Set top-level confirm=true, or use mode=merge.",
        ]);
      }

      const existingRaw = readLarsConfigRaw();
      let outputRaw = importedRaw;
      let added = imported.config.workspaceNames;
      let replaced: string[] = [];
      if (mode === "merge" && existingRaw !== undefined) {
        const merged = mergeLarsConfigRaw(existingRaw, importedRaw);
        if ("error" in merged) return configParseFailure(merged.error);
        outputRaw = merged.xml;
        added = merged.added;
        replaced = merged.replaced;
      }

      // Validate the complete merged document, not only the imported subset.
      const finalConfig = parseLarsConfig(outputRaw);
      if (!finalConfig.ok) return configParseFailure(finalConfig.error);
      const finalValidation = validateLarsWorkspaces(finalConfig.config.workspaces);
      if (finalValidation.errors.length > 0) {
        return failure("INVALID_PARAMS", finalValidation.errors[0]!, finalValidation.errors);
      }

      if (ctx.dryRun) {
        return {
          ok: true,
          data: {
            dryRun: true,
            mode,
            added,
            replaced,
            warnings: [...validation.warnings, ...finalValidation.warnings],
            workspaces: finalConfig.config.workspaceNames,
          },
          hints: ["No file was written. Re-run without dry_run to apply."],
        };
      }

      const write = writeLarsConfigRaw(outputRaw);
      return {
        ok: true,
        data: {
          mode,
          path: write.path,
          backupPath: write.backupPath ?? null,
          bytes: write.bytes,
          added,
          replaced,
          warnings: [...validation.warnings, ...finalValidation.warnings],
          workspaces: finalConfig.config.workspaceNames,
        },
        hints: ["Restart any running LARS instance whose port or memory settings changed."],
      };
    },
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    dryRunSupported: true,
    idempotent: true,
    tags: ["lars", "workspace", "import", "restore", "config", "backup"],
    examples: [
      {
        params: { input_path: "C:\\Backup\\lasalos2.xml" },
        note: "Merge workspaces from a backup without touching unrelated workspaces.",
      },
      {
        params: { input_path: "C:\\Backup\\lasalos2.xml", mode: "replace" },
        note: "Replace the whole config (requires confirm=true at the call site).",
      },
    ],
  }),

  defineAction({
    id: "lars.instance.list",
    aliases: ["lars_list_instances", "lars_running_instances"],
    domain: "lars",
    summary: "List LARS instances with configured and effective ports, PIDs and health.",
    schema: z.object({}),
    handler: async () => {
      const workspaces = readLarsWorkspaces();
      const instances = await Promise.all(
        workspaces.map(async (workspace) => ({
          name: workspace.name,
          onlinePort: workspace.onlinePort,
          dataRoot: workspace.dataRoot ?? null,
          screenProjectPath: workspace.screenProjectPath ?? null,
          ...(await runtimeSummary(workspace.name, workspace.onlinePort)),
        })),
      );
      return {
        ok: true,
        data: {
          instances,
          total: instances.length,
          running: instances.filter((instance) => instance.running).length,
        },
      };
    },
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    idempotent: true,
    tags: ["lars", "instance", "list", "running", "ports", "status"],
    examples: [{ params: {}, note: "List all configured and running instances." }],
  }),

  defineAction({
    id: "lars.instance.status",
    aliases: ["lars_instance_info", "lars_status_instance"],
    domain: "lars",
    summary: "Show one LARS instance's runtime state, effective port, health and station mapping.",
    schema: z.object({ name: workspaceName }),
    handler: async (params) => {
      const workspace = readLarsWorkspaces().find((candidate) => candidate.name === params.name);
      if (!workspace) {
        return failure("PRECONDITION_FAILED", `No LARS workspace named '${params.name}'.`, [
          "Run lars.workspace.list to see configured workspaces.",
        ]);
      }
      const runtime = await runtimeSummary(params.name, workspace.onlinePort);
      return {
        ok: true,
        data: {
          name: workspace.name,
          onlinePort: workspace.onlinePort,
          dataRoot: workspace.dataRoot ?? null,
          screenProjectPath: workspace.screenProjectPath ?? null,
          driveMaps: workspace.driveMaps ?? [],
          dataLenMb: workspace.dataLenMb,
          codeLenMb: workspace.codeLenMb,
          ...runtime,
        },
        ...(runtime.running && !runtime.healthy
          ? {
              warnings: [
                "The LARS process is running but the effective online port is not answering. Check the LARS window and lars.doctor.",
              ],
            }
          : {}),
      };
    },
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    idempotent: true,
    tags: ["lars", "instance", "status", "health", "port", "pid"],
    examples: [{ params: { name: "MyProject_PLC" }, note: "Check one instance." }],
  }),

  defineAction({
    id: "lars.instance.restart",
    aliases: ["lars_restart_instance", "lars_restart"],
    domain: "lars",
    summary: "Stop and start a LARS instance, re-probing its effective online port.",
    schema: z.object({
      name: z.string().optional().describe("Workspace name. Required when station is omitted."),
      station: z.string().optional().describe("Station name from the selected project."),
      project_dir: projectDir,
    }),
    handler: async (params) => {
      if (!params.name && !params.station) {
        return failure("INVALID_PARAMS", "Provide either 'name' (workspace) or 'station' (station name).");
      }
      const stopped = await larsRuntimeHandler({
        action: "stop",
        name: params.name,
        station: params.station,
        project_dir: params.project_dir,
      });
      if (stopped.isError) return fromToolResponse(stopped);
      const started = await larsRuntimeHandler({
        action: "start",
        name: params.name,
        station: params.station,
        project_dir: params.project_dir,
      });
      const startData = toolData(started);
      if (started.isError) {
        return {
          ok: false,
          data: { stop: toolData(stopped), start: startData },
          error: {
            code: "ACTION_FAILED",
            message: typeof startData.error === "string" ? startData.error : "The instance did not start.",
          },
        };
      }
      return {
        ok: true,
        data: { stop: toolData(stopped), start: startData },
        hints: ["If the effective online port changed, run lars.station.target again before reading PLC values."],
      };
    },
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: false,
    asyncCapable: true,
    tags: ["lars", "instance", "restart", "stop", "start", "port"],
    examples: [{ params: { name: "MyProject_PLC" }, note: "Restart one workspace." }],
  }),

  defineAction({
    id: "lars.instance.logs",
    aliases: ["lars_instance_log", "lars_logs", "lars_read_log"],
    domain: "lars",
    summary: "Read the tail of a LARS log file, discovering common install/data-root locations.",
    description:
      "Pass log_path when the build writes its log somewhere specific. Without it the action checks the " +
      "LARS install directory, %APPDATA%, the workspace data root and the MCP scratch folder.",
    schema: z.object({
      name: workspaceName,
      lines: z.number().int().min(1).max(5000).optional().default(200).describe("Number of trailing lines."),
      log_path: z.string().optional().describe("Explicit log file path."),
    }),
    handler: async (params) => {
      const workspace = readLarsWorkspaces().find((candidate) => candidate.name === params.name);
      if (!workspace) {
        return failure("PRECONDITION_FAILED", `No LARS workspace named '${params.name}'.`);
      }
      const candidates = [
        params.log_path,
        join(dirname(LARS_EXE), "Lars.log"),
        join(dirname(LARS_EXE), "Lars.log.txt"),
        join(dirname(LARS_EXE), "lars.log"),
        process.env.APPDATA ? join(process.env.APPDATA, "Lars.log") : undefined,
        process.env.APPDATA ? join(process.env.APPDATA, "Sigmatek", "Lars", "Lars.log") : undefined,
        workspace.dataRoot ? join(workspace.dataRoot, "Lars.log") : undefined,
        workspace.dataRoot ? join(workspace.dataRoot, "lars.log") : undefined,
        join(SCRATCH, "lars.log"),
      ].filter((candidate): candidate is string => Boolean(candidate));

      const path = candidates.find((candidate) => existsSync(candidate));
      if (!path) {
        return {
          ok: true,
          data: {
            found: false,
            workspace: params.name,
            candidates,
            hint: "No LARS log found. Use log_path if this build writes its log elsewhere.",
          },
        };
      }

      const content = readFileSync(path, "utf-8");
      const allLines = content.split(/\r?\n/);
      const count = params.lines ?? 200;
      const tail = allLines.slice(-count);
      const stat = statSync(path);
      return {
        ok: true,
        data: {
          found: true,
          workspace: params.name,
          path,
          lines: tail.length,
          totalLines: allLines.length,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          tail,
        },
      };
    },
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    idempotent: true,
    tags: ["lars", "instance", "logs", "diagnostics", "tail"],
    examples: [
      { params: { name: "MyProject_PLC", lines: 100 }, note: "Read the last 100 log lines." },
      {
        params: { name: "MyProject_PLC", log_path: "C:\\Lars\\custom.log" },
        note: "Read a specific log file.",
      },
    ],
  }),
];
