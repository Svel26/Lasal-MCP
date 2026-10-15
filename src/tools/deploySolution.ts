import { z } from "zod";
import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { readState } from "../state.js";
import { findLsmPath, parseSolution } from "../utils/projectScanner.js";
import {
  buildLutc,
  runMachineManager,
  type LutcInstruction,
  type LutcInstructionData,
  type LutcTarget,
} from "../utils/lutc.js";
import { SCRATCH, withEngineLock } from "../utils/engine.js";
import { ensureScratch } from "../core/scratch.js";
import { TIMEOUTS } from "../utils/config.js";
import { respond, fail, type ToolResponse } from "../utils/respond.js";
import { writeFileSync } from "fs";

// ─── deploy_solution ──────────────────────────────────────────────────────────
//
// Builds a MachineManager `.lutc` update file from the selected solution and
// runs `MachineManager.exe /update:"<file>"`. This is the official multi-station
// flow and the only supported way to push LASAL SCREEN projects with a CLASS 2
// project in one orchestrated run (instruction `DwnLdLSE`).

const fileOpSchema = z.object({
  direction: z.enum(["download", "upload", "delete", "mkdir", "move", "exists"]),
  local_path: z.string().optional().describe("Local source (download/move/upload target)"),
  remote_path: z.string().describe("Path on the control"),
  target_path: z.string().optional().describe("move: destination path on the control"),
  folder: z.boolean().optional().default(false).describe("Transfer a whole folder instead of a single file"),
});

const stationDeploySchema = z.object({
  station: z.string().describe("Station name as defined in the .lsm solution"),
  class2: z
    .union([
      z.literal(true),
      z.object({
        artifact_path: z.string().optional().describe("Override .lcp path (defaults to the station's CLASS 2 project)"),
        save_prj: z.boolean().optional().default(true).describe("Save the downloaded project permanently on the PLC"),
        platform: z.string().optional().describe('Target platform, e.g. "Arm" or "X86" (omit to keep project target)'),
      }),
    ])
    .optional()
    .describe("Download the station's CLASS 2 project (true = defaults)"),
  screen: z
    .union([
      z.literal(true),
      z.object({
        artifact_path: z
          .string()
          .optional()
          .describe("Override .lpr path or compiled Runtime folder (defaults to the station's LASAL Screen project)"),
      }),
    ])
    .optional()
    .describe("Download the station's LASAL SCREEN (.lpr) project (true = defaults)"),
  visu: z
    .union([
      z.literal(true),
      z.object({
        artifact_path: z
          .string()
          .optional()
          .describe("Publish folder or .lvp file (defaults to the station's project)"),
        runtime_path: z.string().optional().describe("Optional runtime folder (…/Runtime/rt)"),
      }),
    ])
    .optional()
    .describe("Download the station's VISUDesigner project (true = defaults)"),
  os: z
    .object({
      file: z.string().describe("OS image (.lbi)"),
      reboot_timeout_ms: z.number().int().optional().default(600000),
    })
    .optional(),
  run: z.boolean().optional().describe("Start the application on the station after transfer (PrjRun)"),
  boot: z
    .union([z.boolean(), z.number().int()])
    .optional()
    .describe("Boot the station (true = default timeout, or milliseconds)"),
  write: z
    .array(z.object({ channel: z.string(), value: z.union([z.string(), z.number()]) }))
    .optional()
    .describe("Write values to server channels after the transfer (WrNr)"),
  cli: z
    .array(z.string())
    .optional()
    .describe('Run target CLI commands, e.g. "REXX C:\\ip_system\\ip_system.rex" (CLICmd)'),
  packages: z
    .array(z.object({ name: z.string(), file: z.string() }))
    .optional()
    .describe("Install packages (name + local zip) — e.g. dataservice/nginx on IPCs (InstPack)"),
  files: z.array(fileOpSchema).optional().describe("File/folder operations on the station"),
});

export const deploySolutionSchema = {
  lsm_path: z.string().optional().describe("Path to the .lsm solution. Omit to use the selected project."),
  stations: z
    .array(stationDeploySchema)
    .describe(
      "Ordered per-station deploy steps. Instructions are emitted per station in field order: class2 → screen → visu → run → write → cli → packages → os → boot → files.",
    ),
  utc_path: z
    .string()
    .optional()
    .describe("Where to write the generated .lutc update file (default: MCP scratch directory)."),
  machine_nr: z.string().optional().describe('Machine number used in the update log, e.g. "042". Default "000".'),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("Generate and return the .lutc without executing MachineManager (plan review)."),
  timeout_s: z.number().int().optional().describe("Timeout override for the whole update run."),
};

type StationDeploy = z.infer<typeof stationDeploySchema>;

interface BuildResult {
  targets: LutcTarget[];
  instructions: LutcInstruction[];
  problems: string[];
}

function buildFromStations(
  soln: ReturnType<typeof parseSolution>,
  stations: StationDeploy[],
  overrides: Map<string, LutcTarget>,
): BuildResult {
  const problems: string[] = [];
  const targets: LutcTarget[] = [];
  const instructions: LutcInstruction[] = [];
  const seen = new Set<string>();

  const stationByName = new Map(soln.stations.map((s) => [s.name.toLowerCase(), s]));
  const referenced = new Set<string>();

  for (const spec of stations) {
    const stn = stationByName.get(spec.station.toLowerCase());
    if (!stn) {
      problems.push(
        `Station '${spec.station}' not found in the solution. Available: ${soln.stations.map((s) => s.name).join(", ")}`,
      );
      continue;
    }
    referenced.add(spec.station.toLowerCase());
    if (!seen.has(spec.station.toLowerCase())) {
      seen.add(spec.station.toLowerCase());
      const override = overrides.get(spec.station.toLowerCase());
      const ip = override?.ip ?? stn.ip;
      if (!ip) {
        problems.push(`Station '${spec.station}' has no TCPIP target in its .lss — set one via set_target_ip first.`);
        continue;
      }
      targets.push({
        station: stn.name,
        ip,
        port: override?.port ?? stn.port ?? "1954",
        ssltls: override?.ssltls ?? stn.ssltls ?? "0",
        configName: override?.configName,
      });
    }

    const push = (instr: LutcInstructionData) => instructions.push({ ...instr, station: stn.name } as LutcInstruction);

    // class2
    if (spec.class2) {
      const opts: { artifact_path?: string; save_prj?: boolean; platform?: string } =
        spec.class2 === true ? {} : spec.class2;
      const file = opts.artifact_path ?? stn.lcpPaths[0];
      if (!file) problems.push(`Station '${spec.station}': no CLASS 2 project found — pass class2.artifact_path.`);
      else if (!existsSync(file)) problems.push(`Station '${spec.station}': CLASS 2 artifact not found: ${file}`);
      else {
        push({
          kind: "class2",
          file,
          savePrj: opts.save_prj,
          ...(opts.platform ? { platform: opts.platform } : {}),
        });
      }
    }
    // screen
    if (spec.screen) {
      const opts: { artifact_path?: string } = spec.screen === true ? {} : spec.screen;
      const file = opts.artifact_path ?? stn.lprPaths[0];
      if (!file) problems.push(`Station '${spec.station}': no LASAL SCREEN project found — pass screen.artifact_path.`);
      else if (!existsSync(file)) problems.push(`Station '${spec.station}': SCREEN artifact not found: ${file}`);
      else push({ kind: "screen", file });
    }
    // visu
    if (spec.visu) {
      const opts: { artifact_path?: string; runtime_path?: string } = spec.visu === true ? {} : spec.visu;
      const file = opts.artifact_path ?? stn.lvpPaths[0];
      if (!file) problems.push(`Station '${spec.station}': no VISUDesigner project found — pass visu.artifact_path.`);
      else if (!existsSync(file)) problems.push(`Station '${spec.station}': VISU artifact not found: ${file}`);
      else push({ kind: "visu", file, ...(opts.runtime_path ? { runtimeFile: opts.runtime_path } : {}) });
    }
    if (spec.run) push({ kind: "run" });
    for (const w of spec.write ?? []) push({ kind: "write", channel: w.channel, value: w.value });
    for (const c of spec.cli ?? []) push({ kind: "cli", command: c });
    for (const p of spec.packages ?? []) push({ kind: "package", name: p.name, file: p.file });
    if (spec.os) push({ kind: "os", file: spec.os.file, rebootTimeoutMs: spec.os.reboot_timeout_ms });
    if (spec.boot !== undefined && spec.boot !== false) {
      push({ kind: "boot", ...(typeof spec.boot === "number" ? { timeoutMs: spec.boot } : {}) });
    }
    for (const f of spec.files ?? []) {
      if (f.direction === "download" && !f.local_path)
        problems.push(`Station '${spec.station}': files.download requires local_path.`);
      if (f.direction === "upload" && !f.local_path)
        problems.push(`Station '${spec.station}': files.upload requires local_path.`);
      if (f.direction === "move" && !f.target_path)
        problems.push(`Station '${spec.station}': files.move requires target_path.`);
      push({
        kind: "file",
        direction: f.direction,
        localPath: f.local_path,
        remotePath: f.remote_path,
        targetPath: f.target_path,
        folder: f.folder,
      });
    }
  }

  return { targets, instructions, problems };
}

export async function deploySolutionHandler(args: {
  lsm_path?: string;
  stations: StationDeploy[];
  utc_path?: string;
  machine_nr?: string;
  dry_run?: boolean;
  timeout_s?: number;
}): Promise<ToolResponse> {
  return withEngineLock(async () => {
    const state = readState();

    let lsmPath = args.lsm_path;
    if (!lsmPath) {
      if (!state.currentProject) {
        return fail("No project selected.", ["Call select_project first or pass lsm_path."]);
      }
      const found = findLsmPath(state.currentProject);
      if (!found)
        return fail(`No .lsm solution file found in ${state.currentProject}`, [
          "Check the selected project directory.",
        ]);
      lsmPath = found;
    }
    if (!existsSync(lsmPath)) {
      return fail(`Solution file not found: ${lsmPath}`, ["Verify the path to the .lsm file."]);
    }

    let soln;
    try {
      soln = parseSolution(lsmPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`Failed to parse solution: ${msg}`, []);
    }
    if (soln.stations.length === 0) {
      return fail("No stations found in the solution.", ["Ensure the .lsm references .lss station files."]);
    }

    const { targets, instructions, problems } = buildFromStations(soln, args.stations, new Map());
    if (problems.length > 0) {
      return fail(`Deploy plan has unresolved issues:\n${problems.join("\n")}`, [
        "Fix the reported paths/targets, or use set_target_ip to define station TCPIP targets.",
      ]);
    }
    if (instructions.length === 0) {
      return fail("No instructions to execute.", ["Configure at least one of class2/screen/visu/files per station."]);
    }

    let utcPath = args.utc_path;
    if (!utcPath) {
      ensureScratch();
      utcPath = join(SCRATCH, `deploy_${randomUUID()}.lutc`);
    }
    const xml = buildLutc({ targets, instructions, machineNr: args.machine_nr });
    try {
      writeFileSync(utcPath, xml, "latin1");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`Failed to write .lutc to ${utcPath}: ${msg}`, []);
    }

    const plan = {
      lsmPath,
      targets: targets.map((t) => ({ station: t.station, ip: t.ip, port: t.port })),
      instructions: instructions.map((i) => i.kind),
      utcPath,
    };

    if (args.dry_run) {
      return respond({
        ok: true,
        dryRun: true,
        ...plan,
        lutc: xml,
      });
    }

    const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.mm;
    const r = await runMachineManager(utcPath, timeoutMs);

    return respond({
      ok: r.ok,
      ...plan,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      ...(r.stdoutTail.length ? { stdout: r.stdoutTail } : {}),
      ...(r.stderrTail.length ? { stderr: r.stderrTail } : {}),
      ...(r.errors.length ? { errors: r.errors } : {}),
      ...(r.hints.length ? { hints: r.hints } : {}),
    });
  });
}
