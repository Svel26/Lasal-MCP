import { z } from "zod";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { runScript, emitPath, type BatchResult } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";
import { ensureScratch } from "../core/scratch.js";
import { respond, fail } from "../utils/respond.js";

// ─── create_class2_bootdisk ───────────────────────────────────────────────────
//
// Wraps batch.CreateBootdisk (plain bootdisk) and batch.CreateBootdiskMngr
// (update-stick flavor: update script, autoexec, LasalOS image, VISUDesigner
// publish folder, MultiMaster Stations.txt). Verified against CLASS 2 02.04:
//   CreateBootdisk(prj, path, overwrite, allLobsInOne, platformType)
//   CreateBootdiskMngr(prj, path, overwrite, allLobsInOne, iType, addAutoexec,
//     strPathVisu, strFileOS, strFileAutoexec, useActiveConnectionFiles,
//     platformType, addMultiMasterStationsTXT, folderVisu_LVD, lvdRuntimeFlag)
//   platformType: -1 AUTO | 0 ALL | 1 ARM | 2 X86;  iType: 0 none | 1 all | 2 menu

const PLATFORM_NUM: Record<string, number> = { AUTO: -1, ALL: 0, ARM: 1, X86: 2 };
const UPDATE_SCRIPT_NUM: Record<string, number> = { none: 0, all: 1, menu: 2 };

function countFiles(dir: string): { fileCount: number; lastModifiedMs: number } {
  let fileCount = 0;
  let lastModifiedMs = 0;
  const walk = (d: string): void => {
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDir) walk(full);
      else {
        fileCount += 1;
        try {
          const st = statSync(full);
          if (st.mtimeMs > lastModifiedMs) lastModifiedMs = st.mtimeMs;
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { fileCount, lastModifiedMs };
}

export const createBootdiskSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  output_path: z.string().describe("Directory to write the bootdisk into (e.g. a prepared USB stick root)."),
  overwrite: z.boolean().optional().default(true).describe("Overwrite existing bootdisk content. Default true."),
  all_lobs_in_one: z.boolean().optional().default(false).describe("Write all .lob files into a single file."),
  platform: z
    .enum(["AUTO", "ALL", "ARM", "X86"])
    .optional()
    .default("AUTO")
    .describe("Target architecture: AUTO (project target), ALL, ARM or X86. Default AUTO."),
  update_script: z
    .enum(["none", "all", "menu"])
    .optional()
    .default("none")
    .describe("Update-tool script flavor (update-stick mode): none, all (runs every update) or menu. Default none."),
  add_autoexec: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Place an autoexec.lsl into the destination directory that starts the update script (update-stick mode).",
    ),
  autoexec_file: z
    .string()
    .optional()
    .describe("Path of a regular Autoexec.lsl to place on the PLC (update-stick mode)."),
  os_file: z.string().optional().describe("LasalOS image (.lbi) to include (update-stick mode)."),
  visu_publish_folder: z
    .string()
    .optional()
    .describe("VISUDesigner 'Publish' folder to bundle into the update (update-stick mode)."),
  lvd_runtime: z
    .boolean()
    .optional()
    .default(true)
    .describe("When a VISUDesigner publish folder is set: also use its Runtime directory. Default true."),
  use_active_connection_files: z
    .boolean()
    .optional()
    .default(true)
    .describe("Use the project's active connection files (update-stick mode). Default true."),
  add_multimaster_stations: z
    .boolean()
    .optional()
    .default(true)
    .describe("Copy the MultiMaster Stations.txt into the destination (update-stick mode). Default true."),
  mode: z
    .enum(["simple", "update_stick"])
    .optional()
    .describe(
      "Bootdisk flavor. Default: update_stick when any of os_file/visu_publish_folder/autoexec_file/add_autoexec/update_script is used, otherwise simple.",
    ),
  timeout_s: z.number().int().optional().default(300).describe("Timeout in seconds. Default 300."),
};

export async function createBootdiskHandler(args: {
  lcp_path?: string;
  output_path: string;
  overwrite?: boolean;
  all_lobs_in_one?: boolean;
  platform?: "AUTO" | "ALL" | "ARM" | "X86";
  update_script?: "none" | "all" | "menu";
  add_autoexec?: boolean;
  autoexec_file?: string;
  os_file?: string;
  visu_publish_folder?: string;
  lvd_runtime?: boolean;
  use_active_connection_files?: boolean;
  add_multimaster_stations?: boolean;
  mode?: "simple" | "update_stick";
  timeout_s?: number;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
  }

  const platformNum = PLATFORM_NUM[args.platform ?? "AUTO"] ?? -1;
  const iType = UPDATE_SCRIPT_NUM[args.update_script ?? "none"] ?? 0;
  const updateStick =
    args.mode === "update_stick" ||
    (args.mode === undefined &&
      (!!args.os_file ||
        !!args.visu_publish_folder ||
        !!args.autoexec_file ||
        args.add_autoexec === true ||
        (args.update_script ?? "none") !== "none"));

  for (const [label, p] of [
    ["os_file", args.os_file],
    ["autoexec_file", args.autoexec_file],
    ["visu_publish_folder", args.visu_publish_folder],
  ] as const) {
    if (p && !existsSync(p)) {
      return fail(`${label} not found: ${p}`, []);
    }
  }

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `bootdisk_${id}.log`);
  const outputPath = args.output_path;
  const overwrite = args.overwrite ?? true;
  const allLobs = args.all_lobs_in_one ?? false;

  const call = updateStick
    ? `batch.CreateBootdiskMngr(prj, ${emitPath(outputPath)}, ${overwrite ? "True" : "False"}, ${allLobs ? "True" : "False"}, ${iType}, ${args.add_autoexec ? "True" : "False"}, u"".encode('mbcs'), ${args.os_file ? emitPath(args.os_file) : "u\"\".encode('mbcs')"}, ${args.autoexec_file ? emitPath(args.autoexec_file) : "u\"\".encode('mbcs')"}, ${args.use_active_connection_files !== false ? "True" : "False"}, ${platformNum}, ${args.add_multimaster_stations !== false ? "True" : "False"}, ${args.visu_publish_folder ? emitPath(args.visu_publish_folder) : "u\"\".encode('mbcs')"}, ${args.lvd_runtime !== false ? "True" : "False"})`
    : `batch.CreateBootdisk(prj, ${emitPath(outputPath)}, ${overwrite ? "True" : "False"}, ${allLobs ? "True" : "False"}, ${platformNum})`;

  const script =
    [
      "# -*- coding: utf-8 -*-",
      "import sigmatek.lasal.batch as batch",
      "batch.SetExceptionOnError(True)",
      `batch.OpenLogfile(${emitPath(logPath)})`,
      `prj = batch.LoadProject(${emitPath(resolved.path)})`,
      call,
      `if not __import__('os').path.isdir(${emitPath(outputPath)}): raise RuntimeError("Bootdisk output directory was not created")`,
      "batch.CloseProject(prj)",
    ].join("\n") + "\n";

  return withEngineLock(async () => {
    const br: BatchResult = await runScript(script, logPath, (args.timeout_s ?? 300) * 1000);
    if (!br.ok) {
      const body: { ok: boolean; [k: string]: unknown } = {
        ok: false,
        mode: updateStick ? "update_stick" : "simple",
        outputPath,
        durationMs: br.durationMs,
        ...(br.errors.length ? { errors: br.errors } : {}),
        logPath: br.logPath,
      };
      return respond(body);
    }

    const { fileCount, lastModifiedMs } = countFiles(outputPath);
    return respond({
      ok: true,
      mode: updateStick ? "update_stick" : "simple",
      lcpPath: resolved.path,
      outputPath,
      platform: args.platform ?? "AUTO",
      fileCount,
      lastModifiedMs: lastModifiedMs || null,
      durationMs: br.durationMs,
      logPath: br.logPath,
      ...(updateStick
        ? {
            updateScript: args.update_script ?? "none",
            includes: {
              osFile: args.os_file ?? null,
              autoexecFile: args.autoexec_file ?? null,
              visuPublishFolder: args.visu_publish_folder ?? null,
            },
          }
        : {}),
    });
  });
}
