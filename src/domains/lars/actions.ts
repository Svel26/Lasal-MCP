import { existsSync } from "fs";
import { isAbsolute, resolve, parse as parsePath } from "path";
import { z } from "zod";
import { fromToolResponse } from "../../core/actions/legacy.js";
import { defineAction } from "../../core/actions/types.js";
import { larsRuntimeHandler } from "../../tools/larsRuntime.js";
import { larsDoctorHandler } from "../../tools/larsDoctor.js";
import { larsScenarioSchema, runLarsScenario } from "../../tools/larsScenario.js";
import { patchLarsWorkspace, readLarsWorkspaces } from "../../utils/lars.js";

const name = z.string().optional().describe("LARS workspace name, e.g. 'MyProject_PLC'.");
const station = z.string().optional().describe("Station name from the selected solution, e.g. 'PLC' or 'HMI'.");
const projectDir = z.string().optional().describe("Solution directory. Omit to use the selected project.");

function lars(params: Parameters<typeof larsRuntimeHandler>[0]) {
  return larsRuntimeHandler(params);
}

type LarsWorkspace = ReturnType<typeof readLarsWorkspaces>[number];

function normalizeDrive(value: string): string {
  return `${value.replace(/:$/, "").toUpperCase()}:`;
}

function validateWorkspacePatch(
  existing: LarsWorkspace,
  patch: Partial<Omit<LarsWorkspace, "name">>,
  others: LarsWorkspace[],
): string | undefined {
  const candidate = { ...existing, ...patch };
  const ports: Array<[string, number | undefined]> = [
    ["onlinePort", candidate.onlinePort],
    ["comlinkServerPort", candidate.comlinkServerPort],
    ["comlinkBasePort", candidate.comlinkBasePort],
    ["alarmPort", candidate.alarmPort],
    ["dataServiceTcpPort", candidate.dataServiceTcpPort],
  ];
  const seen = new Map<number, string>();
  for (const [label, port] of ports) {
    if (port === undefined) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `${label} must be between 1 and 65535.`;
    const duplicate = seen.get(port);
    if (duplicate) return `${label} and ${duplicate} cannot use the same port (${port}).`;
    seen.set(port, label);
  }
  for (const other of others) {
    const otherPorts = new Set(
      [
        other.onlinePort,
        other.comlinkServerPort,
        other.comlinkBasePort,
        other.alarmPort,
        other.dataServiceTcpPort,
      ].filter((port): port is number => port !== undefined),
    );
    for (const [label, port] of ports) {
      if (port !== undefined && otherPorts.has(port)) {
        return `${label} port ${port} is already used by workspace '${other.name}'.`;
      }
    }
  }

  if (patch.dataRoot) {
    if (!isAbsolute(patch.dataRoot)) return "dataRoot must be an absolute host path.";
    const resolved = resolve(patch.dataRoot);
    if (resolved.toLowerCase() === parsePath(resolved).root.toLowerCase()) {
      return "dataRoot cannot be a drive root; every workspace needs an isolated host folder.";
    }
    const shared = others.find(
      (other) => other.dataRoot && resolve(other.dataRoot).toLowerCase() === resolved.toLowerCase(),
    );
    if (shared) return `dataRoot is already used by workspace '${shared.name}'.`;
  }
  if (patch.screenProjectPath && !existsSync(patch.screenProjectPath)) {
    return `screenProjectPath not found: ${patch.screenProjectPath}`;
  }
  if (patch.driveMaps) {
    const seenDrives = new Set<string>();
    for (const map of patch.driveMaps) {
      const drive = normalizeDrive(map.drive);
      if (!/^[A-Z]:$/.test(drive)) return `Invalid drive '${map.drive}'. Use a letter such as D:.`;
      if (drive === "C:") return "Use dataRoot for the C: drive mapping.";
      if (seenDrives.has(drive)) return `Drive ${drive} is listed more than once.`;
      if (!isAbsolute(map.path)) return `Drive ${drive} path must be absolute.`;
      const resolved = resolve(map.path);
      if (resolved.toLowerCase() === parsePath(resolved).root.toLowerCase()) {
        return `Drive ${drive} cannot map to a host drive root.`;
      }
      seenDrives.add(drive);
    }
  }
  if (patch.dataLenMb !== undefined && patch.dataLenMb <= 0) return "dataLenMb must be positive.";
  if (patch.codeLenMb !== undefined && patch.codeLenMb <= 0) return "codeLenMb must be positive.";
  return undefined;
}

export const larsActions = [
  defineAction({
    id: "lars.workspace.list",
    aliases: ["lars_runtime_list", "lars_list"],
    domain: "lars",
    summary: "List LARS workspaces, running instances, effective ports and unconfigured stations.",
    schema: z.object({ project_dir: projectDir }),
    handler: async (params) => fromToolResponse(await lars({ action: "list", project_dir: params.project_dir })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "workspace", "list", "runtime", "ports"],
    examples: [{ params: {}, note: "List all workspaces and running instances." }],
  }),

  defineAction({
    id: "lars.workspace.setup",
    aliases: ["lars_runtime_setup", "lars_setup"],
    domain: "lars",
    summary: "Create or update LARS workspaces for the selected project's stations.",
    schema: z.object({ name, station, lcp_path: z.string().optional(), project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({
          action: "setup",
          name: params.name,
          station: params.station,
          lcp_path: params.lcp_path,
          project_dir: params.project_dir,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["lars", "workspace", "setup", "create", "config"],
    examples: [{ params: {}, note: "Create workspaces for every station in the selected project." }],
  }),

  defineAction({
    id: "lars.workspace.update",
    aliases: ["lars_runtime_update", "lars_update_workspace"],
    domain: "lars",
    summary: "Update an existing LARS workspace's ports, paths, memory sizes or screen project.",
    description:
      "Changes one existing workspace under the LARS config lock. Ports must be unique across all workspaces; dataRoot must be an isolated absolute folder.",
    schema: z.object({
      name: z.string().describe("Existing workspace name."),
      onlinePort: z.number().int().min(1).max(65535).optional(),
      comlinkServerPort: z.number().int().min(1).max(65535).optional(),
      comlinkBasePort: z.number().int().min(1).max(65535).optional(),
      alarmPort: z.number().int().min(1).max(65535).optional(),
      dataServiceTcpPort: z.number().int().min(1).max(65535).optional(),
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
    }),
    handler: async (params) => {
      const { name: workspaceName, ...patch } = params;
      const workspaces = readLarsWorkspaces();
      const existing = workspaces.find((workspace) => workspace.name === workspaceName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "PRECONDITION_FAILED",
            message: `No LARS workspace named '${workspaceName}'. Run lars.workspace.setup first or use lars.workspace.list.`,
          },
        };
      }
      const others = workspaces.filter((workspace) => workspace.name !== workspaceName);
      const problem = validateWorkspacePatch(existing, patch, others);
      if (problem) {
        return { ok: false, error: { code: "INVALID_PARAMS", message: problem }, hints: ["No changes were written."] };
      }
      const updated = patchLarsWorkspace(workspaceName, patch);
      if (!updated) {
        return {
          ok: false,
          error: { code: "PRECONDITION_FAILED", message: `Workspace '${workspaceName}' disappeared while updating.` },
        };
      }
      return {
        ok: true,
        data: updated,
        hints: ["Restart the LARS instance for port or memory changes to take effect."],
      };
    },
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "workspace", "update", "config", "ports", "memory"],
    examples: [
      {
        params: { name: "MyProject_PLC", onlinePort: 1974, dataLenMb: 64 },
        note: "Move a workspace to a new online port and increase its data memory.",
      },
    ],
  }),

  defineAction({
    id: "lars.workspace.remove",
    aliases: ["lars_runtime_remove", "lars_remove"],
    domain: "lars",
    summary: "Remove a LARS workspace configuration.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({ action: "remove", name: params.name, station: params.station, project_dir: params.project_dir }),
      ),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: false,
    tags: ["lars", "workspace", "remove", "delete"],
    examples: [{ params: { name: "MyProject_PLC" }, note: "Remove one workspace." }],
  }),

  defineAction({
    id: "lars.workspace.gc",
    aliases: ["lars_runtime_gc", "lars_gc"],
    domain: "lars",
    summary: "Collect stale auto-created LARS workspaces that are not running or referenced.",
    schema: z.object({
      dry_run: z.boolean().optional().default(false).describe("Report what would be removed."),
      min_age_h: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Only collect workspaces unreferenced for at least this many hours."),
      project_dir: projectDir,
    }),
    handler: async (params) =>
      fromToolResponse(
        await lars({
          action: "gc",
          dry_run: params.dry_run,
          min_age_h: params.min_age_h,
          project_dir: params.project_dir,
        }),
      ),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: false,
    tags: ["lars", "workspace", "gc", "cleanup"],
    examples: [{ params: { dry_run: true }, note: "Preview stale workspaces." }],
  }),

  defineAction({
    id: "lars.instance.start",
    aliases: ["lars_runtime_start", "lars_start"],
    domain: "lars",
    summary: "Start a LARS simulation instance and report its effective online port.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({ action: "start", name: params.name, station: params.station, project_dir: params.project_dir }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "instance", "start", "simulation"],
    examples: [{ params: { station: "PLC" }, note: "Start the PLC station's LARS instance." }],
  }),

  defineAction({
    id: "lars.instance.stop",
    aliases: ["lars_runtime_stop", "lars_stop"],
    domain: "lars",
    summary: "Stop a LARS simulation instance.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({ action: "stop", name: params.name, station: params.station, project_dir: params.project_dir }),
      ),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: false,
    tags: ["lars", "instance", "stop", "simulation"],
    examples: [{ params: { station: "PLC" }, note: "Stop the PLC station's LARS instance." }],
  }),

  defineAction({
    id: "lars.instance.screenshot",
    aliases: ["lars_runtime_screenshot", "lars_screenshot"],
    domain: "lars",
    summary: "Capture a PNG of a running LARS window, including a rendered LASAL SCREEN project.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({
          action: "screenshot",
          name: params.name,
          station: params.station,
          project_dir: params.project_dir,
        }),
      ),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "instance", "screenshot", "screen", "visual"],
    examples: [{ params: { station: "HMI" }, note: "Screenshot the HMI station's LARS window." }],
  }),

  defineAction({
    id: "lars.station.target",
    aliases: ["lars_set_station_target", "set_lars_target"],
    domain: "lars",
    summary: "Point a station's .lss at its running LARS instance's effective online port.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({
          action: "set_station_target",
          name: params.name,
          station: params.station,
          project_dir: params.project_dir,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "station", "target", "lss", "port"],
    examples: [{ params: { station: "PLC" }, note: "Point the PLC station at its LARS instance." }],
  }),

  defineAction({
    id: "lars.station.restore",
    aliases: ["lars_restore", "restore_lars_target"],
    domain: "lars",
    summary: "Restore a station's original .lss target after LARS simulation.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({ action: "restore", name: params.name, station: params.station, project_dir: params.project_dir }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "station", "restore", "lss", "target"],
    examples: [{ params: { station: "PLC" }, note: "Restore the real PLC target." }],
  }),

  defineAction({
    id: "lars.project.target_pc",
    aliases: ["lars_target_pc", "switch_lars_target_pc"],
    domain: "lars",
    summary: "Switch an ARM-compiled CLASS 2 project to the PC target required by LARS.",
    schema: z.object({ name, station, project_dir: projectDir }),
    handler: async (params) =>
      fromToolResponse(
        await lars({
          action: "target_pc",
          name: params.name,
          station: params.station,
          project_dir: params.project_dir,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["lars", "project", "target", "pc", "arm"],
    examples: [{ params: {}, note: "Switch the selected project to the PC target." }],
  }),

  defineAction({
    id: "lars.simulate",
    aliases: ["lars_runtime_simulate", "lars_simulate"],
    domain: "lars",
    summary: "One-call LARS bring-up: create the workspace, switch ARM to PC, compile, start and download.",
    schema: z.object({
      name,
      station,
      project_dir: projectDir,
      skip_compile: z.boolean().optional().default(false),
      skip_download: z.boolean().optional().default(false),
      compile_mode: z.enum(["RebuildAll", "BuildChanges"]).optional().default("RebuildAll"),
    }),
    handler: async (params) =>
      fromToolResponse(
        await lars({
          action: "simulate",
          name: params.name,
          station: params.station,
          project_dir: params.project_dir,
          skip_compile: params.skip_compile,
          skip_download: params.skip_download,
          compile_mode: params.compile_mode,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["lars", "simulate", "compile", "download", "start", "no-hardware"],
    examples: [{ params: { station: "PLC" }, note: "Bring up the PLC station locally." }],
  }),

  defineAction({
    id: "lars.doctor",
    aliases: ["lars_doctor", "lars_diagnose"],
    domain: "lars",
    summary: "Diagnose LARS installation, workspace config, ports, data roots, drive maps and running instances.",
    schema: z.object({}),
    handler: async () => larsDoctorHandler(),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["lars", "doctor", "diagnose", "ports", "config"],
    examples: [{ params: {}, note: "Check LARS health and workspace conflicts." }],
  }),

  defineAction({
    id: "lars.scenario.run",
    aliases: ["lars_run_scenario", "scenario_run", "plc_scenario"],
    domain: "lars",
    summary: "Run a set/wait/assert scenario against a LARS or PLC connection in one engine call.",
    description:
      "Opens one PLC connection, executes all steps, records structured results and fails on the first assertion or timeout. " +
      "Ideal for a TDD loop against LARS without one engine spawn per value.",
    schema: z.object(larsScenarioSchema),
    handler: async (params) => runLarsScenario(params),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["lars", "scenario", "test", "tdd", "plc", "assert", "wait"],
    examples: [
      {
        params: {
          steps: [
            { type: "set", channel: "Motor1.s_Speed", value: "1200" },
            { type: "wait", channel: "Motor1.s_Speed", equals: "1200", timeout_ms: 2000 },
            { type: "assert", channel: "Motor1.s_Speed", min: 1100, max: 1300 },
          ],
        },
        note: "Write a speed, wait for it, and assert a tolerance.",
      },
    ],
  }),
];
