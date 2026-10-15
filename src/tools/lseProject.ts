import { z } from "zod";
import { runLseOps, type LseOp, type LseResult } from "../utils/lseScript.js";
import { resolveLprPath } from "../utils/resolvePaths.js";
import { findLseOnlineConfig, lseRuntimeInfo, readLseOnlineConfigTarget } from "../utils/lseProject.js";
import { parseSolution, findLsmPath } from "../utils/projectScanner.js";
import { pingHost } from "../utils/preflight.js";
import { withEngineLock } from "../utils/engine.js";
import { getLseRegistration } from "../utils/engine.js";
import { respond, fail, type ToolResponse } from "../utils/respond.js";
import { readState } from "../state.js";
import { TIMEOUTS } from "../utils/config.js";
import { startJob } from "../core/jobs.js";
import { createProgressReporter, type McpExtra } from "../utils/mcpProgress.js";
import { existsSync } from "fs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lseResultToResponse(r: LseResult, extra?: Record<string, unknown>): ToolResponse {
  const body: { ok: boolean; hints?: string[]; [k: string]: unknown } = {
    ok: r.ok,
    durationMs: r.durationMs,
    ...(r.errors.length ? { errors: r.errors } : {}),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
    ...(r.logTail.length ? { logTail: r.logTail } : {}),
    logPath: r.logPath,
    ...(r.hints?.length ? { hints: r.hints } : {}),
    ...extra,
  };
  return respond(body as { ok: boolean });
}

/** Find the solution station that owns a .lpr and return its .lss connection. */
export function resolveStationForLpr(lprPath: string): { station: string; ip?: string; port: string } | null {
  const state = readState();
  const projectDir = state.currentProject;
  if (!projectDir) return null;
  const lsmPath = findLsmPath(projectDir);
  if (!lsmPath) return null;
  try {
    const soln = parseSolution(lsmPath);
    const lprLower = lprPath.toLowerCase();
    const owner = soln.stations.find((s) => s.lprPaths.some((p) => p.toLowerCase() === lprLower));
    if (!owner) return null;
    return { station: owner.name, ip: owner.ip, port: owner.port ?? "1954" };
  } catch {
    return null;
  }
}

// ─── Operation schemas ────────────────────────────────────────────────────────

const buttonUpdateSchema = z.object({
  property: z
    .union([z.string(), z.number().int()])
    .describe(
      "LSButtonProperty constant (name or number): Doubleclick=1, Theme=2, ColorBackground=3, ColorFill=4, ColorText=5, ColorTopLeft=6, ColorBottomRight=7, Zoom=8",
    ),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("New value for the property"),
  inverse: z.boolean().optional().describe("Invert theme imagining where supported"),
});

const settingsSchema = z.object({
  screen_width: z.number().int().optional(),
  screen_height: z.number().int().optional(),
  target_width: z.number().int().optional(),
  target_height: z.number().int().optional(),
  compiler_warnings: z.boolean().optional(),
  compiler_version: z.number().int().optional().describe("LSE compiler version to build with (e.g. 60)"),
  online_ip: z.string().optional().describe("Online/download target IP for the project's online settings"),
  online_connection: z
    .string()
    .optional()
    .describe("Online connection name from the LASAL address book (must already exist; prefer online_ip)"),
});

const OperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("compile") }),
  z.object({
    type: z.literal("merge"),
    file: z.string().describe("Project/export file to merge into the open project (.lpr export)"),
    overwrite: z.boolean().optional().default(true),
    deep_merge: z.boolean().optional(),
    skip_global_screen: z.boolean().optional(),
    screen_x_offset: z.number().int().optional(),
    screen_y_offset: z.number().int().optional(),
    softkey_offset: z.number().int().optional(),
    softkey_valid: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("fuse"),
    file: z.string().describe("Fuse file to apply (updates standard objects with critical changes)"),
    critical_changes: z.boolean().optional().default(true),
  }),
  z.object({
    type: z.literal("export_xml"),
    path: z.string().describe("Destination XML file path"),
    overwrite: z.boolean().optional().default(true),
    languages: z
      .array(z.number().int())
      .optional()
      .describe("LCIDs added to the compilation language list before export (project languages are listed by 'info')"),
    container_info: z.boolean().optional().describe("Include container size + font scheme info for placed texts"),
    sorted_array: z.boolean().optional().describe("Use the sorted text-list array in the XML output"),
  }),
  z.object({
    type: z.literal("import_xml"),
    path: z.string().describe("XML texts file to import (languages/text lists are created on demand)"),
  }),
  z.object({
    type: z.literal("export"),
    path: z.string().describe("Destination for the project export (merge/import format)"),
    settings_file: z.string().optional().describe("Optional .esf export settings file"),
    overwrite: z.boolean().optional().default(false),
  }),
  z.object({
    type: z.literal("import_variables"),
    file: z.string().describe("Variable import file (MaeExp.txt listing or server-list export from LASAL CLASS 2)"),
    station_number: z.number().int().min(0).max(255).describe("Station number of the PLC providing the variables"),
  }),
  z.object({
    type: z.literal("import_scl"),
    name: z.string().describe("Name of the SCL (screen configuration library) entry to import"),
  }),
  z.object({
    type: z.literal("textlist_import_file"),
    file: z.string().describe("LSE text export file (.txt, Excel-compatible) to import as new text lists"),
    language_id: z.number().int().optional().describe("LCID the texts belong to"),
  }),
  z.object({
    type: z.literal("textlist_import"),
    text_list: z.string().describe("Target text list name"),
    file: z.string().describe("Text export file with the list's texts"),
    language_id: z.number().int().optional().describe("LCID the texts belong to"),
  }),
  z.object({
    type: z.literal("textlist_create"),
    name: z.string(),
    text: z.string().optional().describe("Initial text for the new list"),
  }),
  z.object({
    type: z.literal("textlist_add_text"),
    text_list: z.string(),
    text: z.string().optional().describe("Initial text content"),
  }),
  z.object({
    type: z.literal("textlist_set_text"),
    text_list: z.string(),
    item: z.union([z.string(), z.number().int()]).describe("Text item index or GUID"),
    language_id: z.number().int().describe("LCID to write, e.g. 3079 (German/Austria), 2057 (English/UK)"),
    text: z.string().describe("New text value"),
  }),
  z.object({
    type: z.literal("textlist_get_texts"),
    text_list: z.string(),
    languages: z.array(z.number().int()).optional().describe("LCIDs to read (omit for all project languages)"),
  }),
  z.object({ type: z.literal("add_language"), language_id: z.number().int() }),
  z.object({ type: z.literal("clear_languages") }),
  z.object({ type: z.literal("set_actual_language"), language_id: z.number().int() }),
  z.object({
    type: z.literal("update_buttons"),
    updates: z
      .array(buttonUpdateSchema)
      .describe("Bulk property updates for all placed buttons (themes, colors, zoom)"),
  }),
  z.object({
    type: z.literal("update_softkeys"),
    updates: z.array(buttonUpdateSchema).describe("Bulk property updates for all softkeys (Theme=2)"),
  }),
  z.object({ type: z.literal("settings_set"), settings: settingsSchema }),
  z.object({
    type: z.literal("image_insert"),
    file: z.string().describe("Image file path to add (BMP)"),
    transparent_rgb: z.number().int().optional().describe("Transparent color as RGB integer (e.g. 16777215)"),
  }),
  z.object({
    type: z.literal("server_get_property"),
    server: z.string().describe("Server name as listed by 'info' (e.g. '@STD_MerkerMainScreen' or 'Motor1.s_Speed')"),
    property: z
      .union([z.string(), z.number().int()])
      .describe(
        "LSServerProperty name or number: stationnumber, permanent, refreshtime, unit, lowerlimit, upperlimit, menu, stateschema, hostname, link1type, … (full list in docs/LSE_AUTOMATION_REFERENCE.md)",
      ),
  }),
  z.object({
    type: z.literal("server_set_property"),
    server: z.string().describe("Server name as listed by 'info'"),
    property: z.union([z.string(), z.number().int()]).describe("LSServerProperty name or number"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
  }),
]);

type Operation = z.infer<typeof OperationSchema>;

function toLseOp(op: Operation): LseOp {
  switch (op.type) {
    case "compile":
      return { type: "compile" };
    case "merge":
      return {
        type: "merge",
        file: op.file,
        overwrite: op.overwrite,
        deep_merge: op.deep_merge,
        skip_global_screen: op.skip_global_screen,
        screen_x_offset: op.screen_x_offset,
        screen_y_offset: op.screen_y_offset,
        softkey_offset: op.softkey_offset,
        softkey_valid: op.softkey_valid,
      };
    case "fuse":
      return { type: "fuse", file: op.file, critical_changes: op.critical_changes };
    case "export_xml":
      return {
        type: "export_xml",
        path: op.path,
        overwrite: op.overwrite,
        languages: op.languages,
        container_info: op.container_info,
        sorted_array: op.sorted_array,
      };
    case "import_xml":
      return { type: "import_xml", path: op.path };
    case "export":
      return { type: "export", path: op.path, settings_file: op.settings_file, overwrite: op.overwrite };
    case "import_variables":
      return { type: "import_variables", file: op.file, station_number: op.station_number };
    case "import_scl":
      return { type: "import_scl", name: op.name };
    case "textlist_import_file":
      return { type: "textlist_import_file", file: op.file, language_id: op.language_id };
    case "textlist_import":
      return { type: "textlist_import", text_list: op.text_list, file: op.file, language_id: op.language_id };
    case "textlist_create":
      return { type: "textlist_create", name: op.name, text: op.text };
    case "textlist_add_text":
      return { type: "textlist_add_text", text_list: op.text_list, text: op.text };
    case "textlist_set_text":
      return {
        type: "textlist_set_text",
        text_list: op.text_list,
        item: op.item,
        language_id: op.language_id,
        text: op.text,
      };
    case "textlist_get_texts":
      return { type: "textlist_get_texts", text_list: op.text_list, languages: op.languages };
    case "add_language":
      return { type: "add_language", language_id: op.language_id };
    case "clear_languages":
      return { type: "clear_languages" };
    case "set_actual_language":
      return { type: "set_actual_language", language_id: op.language_id };
    case "update_buttons":
      return { type: "update_buttons", updates: op.updates };
    case "update_softkeys":
      return { type: "update_softkeys", updates: op.updates };
    case "settings_set":
      return { type: "settings_set", settings: op.settings };
    case "image_insert":
      return { type: "image_insert", file: op.file, transparent_rgb: op.transparent_rgb };
    case "server_get_property":
      return { type: "server_get_property", server: op.server, property: op.property };
    case "server_set_property":
      return { type: "server_set_property", server: op.server, property: op.property, value: op.value };
  }
}

// ─── lse_project ──────────────────────────────────────────────────────────────

export const lseProjectSchema = {
  action: z
    .enum(["info", "compile", "download", "apply_changes", "create"])
    .describe(
      "'info' inventories the project (screens, windows, servers, text lists, languages, settings) read-only. " +
        "'compile' rebuilds the Runtime output folder. " +
        "'download' pushes the project to the panel (F6-equivalent) via the project's online settings. " +
        "'apply_changes' loads the project, runs the operations list, saves, and closes. " +
        "'create' generates a NEW empty .lpr project at lpr_path (screens can then be laid out in the editor; text lists/data can be prepared via operations).",
    ),
  lpr_path: z
    .string()
    .optional()
    .describe("Full path to the .lpr project file. Omit to auto-detect from the selected project."),
  operations: z
    .array(OperationSchema)
    .optional()
    .describe(
      "Ordered operations for action 'apply_changes'. Each has a 'type' field: " +
        "compile | merge | fuse | export_xml | import_xml | export | import_variables | import_scl | " +
        "textlist_import_file | textlist_import | textlist_create | textlist_add_text | textlist_set_text | textlist_get_texts | " +
        "add_language | clear_languages | set_actual_language | update_buttons | update_softkeys | settings_set | image_insert | " +
        "server_get_property | server_set_property",
    ),
  connection: z
    .string()
    .optional()
    .describe(
      "Download target, e.g. 'TCPIP:192.168.1.50'. Omit to use the station that owns the .lpr in the solution (its .lss target).",
    ),
  run: z
    .boolean()
    .optional()
    .default(true)
    .describe("With action 'download': start the screen runtime on the target after the transfer (Download & Run)."),
  save: z
    .boolean()
    .optional()
    .default(true)
    .describe("With action 'apply_changes': save the project after the operations (set false for read-only exports)."),
  timeout_s: z.number().int().optional().describe("Timeout override in seconds."),
  async: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Run in the background: returns { status: 'pending', jobId } — poll with check_job_status. Default false.",
    ),
};

export async function lseProjectHandler(
  args: {
    action: "info" | "compile" | "download" | "apply_changes" | "create";
    lpr_path?: string;
    operations?: unknown[];
    connection?: string;
    run?: boolean;
    save?: boolean;
    timeout_s?: number;
    async?: boolean;
  },
  extra?: McpExtra,
): Promise<ToolResponse> {
  const reporter = createProgressReporter(extra, "lasal.lse_project");
  const run = () =>
    withEngineLock(async () => {
      const registration = getLseRegistration();
      if (!registration.registered) {
        return fail(
          "The LASAL Screen automation server (LASALScreen.Application) is not registered — the lse_project tool cannot drive the engine.",
          [
            "Open LASAL Screen (LSE_modeless.exe) once and use its registration dialog to register the automation components, then retry.",
            "If the LASAL Screen editor is not installed, install it from the Sigmatek LASAL setup.",
          ],
        );
      }

      // ── create (fresh project) ──
      if (args.action === "create") {
        const target = args.lpr_path;
        if (!target) {
          return fail("lpr_path is required for action 'create' (path of the new .lpr project).", [
            "Example: C:\\Projects\\MyMachine\\Stations\\HMI\\visu.lpr",
          ]);
        }
        if (existsSync(target)) {
          return fail(`File already exists: ${target}`, ["Delete it first or choose another path."]);
        }
        const createTimeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.lse;
        const createOps: LseOp[] = [];
        const createErrors: string[] = [];
        for (let i = 0; i < (args.operations ?? []).length; i++) {
          const parsed = OperationSchema.safeParse((args.operations ?? [])[i]);
          if (parsed.success) {
            try {
              createOps.push(toLseOp(parsed.data));
            } catch (e: unknown) {
              createErrors.push(`Operation[${i}]: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            createErrors.push(`Operation[${i}]: ${parsed.error.message}`);
          }
        }
        if (createErrors.length) {
          return fail(`Invalid operations:\n${createErrors.join("\n")}`, []);
        }
        const r = await runLseOps(target, createOps, { create: true, timeoutMs: createTimeoutMs });
        const runtime = lseRuntimeInfo(target);
        return lseResultToResponse(r, {
          lprPath: target,
          created: true,
          runtime: {
            dir: runtime.runtimeDir,
            compiled: runtime.exists,
            fileCount: runtime.fileCount,
            lastModifiedMs: runtime.lastModifiedMs || null,
          },
        });
      }

      const resolved = resolveLprPath(args.lpr_path);
      if ("error" in resolved) {
        return fail(resolved.error, ["Call select_project first or pass lpr_path explicitly."]);
      }
      const lprPath = resolved.path;
      const timeoutMs = args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.lse;

      // ── info ──
      if (args.action === "info") {
        const r = await runLseOps(lprPath, [{ type: "info" }], { saveAtEnd: false, timeoutMs });
        const runtime = lseRuntimeInfo(lprPath);
        const onlineCfg = findLseOnlineConfig(lprPath);
        const onlineTarget = onlineCfg ? readLseOnlineConfigTarget(onlineCfg) : null;
        const owner = resolveStationForLpr(lprPath);
        return lseResultToResponse(r, {
          lprPath,
          station: owner?.station ?? null,
          onlineConfig: onlineCfg
            ? { path: onlineCfg, target: "error" in (onlineTarget ?? {}) ? null : onlineTarget }
            : null,
          runtime: {
            dir: runtime.runtimeDir,
            compiled: runtime.exists,
            fileCount: runtime.fileCount,
            lastModifiedMs: runtime.lastModifiedMs || null,
          },
        });
      }

      // ── compile ──
      if (args.action === "compile") {
        const r = await runLseOps(lprPath, [{ type: "compile" }], { saveAtEnd: true, timeoutMs });
        const runtime = lseRuntimeInfo(lprPath);
        return lseResultToResponse(r, {
          lprPath,
          runtime: {
            dir: runtime.runtimeDir,
            compiled: runtime.exists,
            fileCount: runtime.fileCount,
            lastModifiedMs: runtime.lastModifiedMs || null,
          },
        });
      }

      // ── download ──
      if (args.action === "download") {
        const owner = resolveStationForLpr(lprPath);
        let connection = args.connection;
        if (!connection && owner?.ip) {
          connection = `TCPIP:${owner.ip}${owner.port && owner.port !== "1954" ? `:${owner.port}` : ""}`;
        }
        if (!connection) {
          const onlineCfg = findLseOnlineConfig(lprPath);
          if (onlineCfg) {
            const t = readLseOnlineConfigTarget(onlineCfg);
            if (!("error" in t) && t.ip) {
              connection = `TCPIP:${t.ip}${t.port && t.port !== "1954" ? `:${t.port}` : ""}`;
            }
          }
        }
        if (!connection) {
          return fail("Could not resolve a download target for the screen project.", [
            "Pass connection ('TCPIP:<ip>'), register the .lpr in a station .lss (SlnScreenProject), or set an online IP in LSEOnlineConfig.xml.",
          ]);
        }

        const ip = connection.replace(/^TCPIP:/i, "").split(":")[0] ?? "";
        const portStr = connection.split(":").pop() ?? "1954";
        const port = parseInt(portStr, 10) || 1954;
        const reachable = await pingHost(ip, port, 2000);
        if (!reachable) {
          return respond({
            ok: false,
            lprPath,
            connectionUsed: connection,
            ipUsed: ip,
            errors: [`Target ${ip}:${port} is unreachable.`],
            hints: [
              "Ensure the panel/control is powered and reachable. Verify with lasal_status, or simulate locally with lars_runtime (SCREEN_PRJ_PATH workspaces).",
            ],
          });
        }

        const r = await runLseOps(lprPath, [{ type: "download", run: args.run ?? true, connection }], {
          saveAtEnd: false,
          timeoutMs,
        });
        return lseResultToResponse(r, { lprPath, connectionUsed: connection, ipUsed: ip });
      }

      // ── apply_changes ──
      const raw = args.operations ?? [];
      const ops: LseOp[] = [];
      const errors: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const parsed = OperationSchema.safeParse(raw[i]);
        if (parsed.success) {
          try {
            ops.push(toLseOp(parsed.data));
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`Operation[${i}]: ${msg}`);
          }
        } else {
          errors.push(`Operation[${i}]: ${parsed.error.message}`);
        }
      }
      if (errors.length) {
        return fail(`Invalid operations:\n${errors.join("\n")}`, []);
      }
      if (ops.length === 0) {
        return fail("No operations provided for apply_changes.", ["Pass an operations array."]);
      }

      const r = await runLseOps(lprPath, ops, { saveAtEnd: args.save ?? true, timeoutMs });
      return lseResultToResponse(r, { lprPath });
    });

  if (args.async) {
    const job = startJob("lse_project", run, (rec) => {
      void reporter.log("info", {
        jobId: rec.id,
        job: rec.name,
        status: rec.status,
        durationMs: rec.durationMs,
        ...(rec.error ? { error: rec.error } : {}),
        hint: "Background job finished — call check_job_status with this jobId for the result.",
      });
    });
    return respond({
      ok: true,
      status: "pending",
      jobId: job.id,
      hints: [
        "This call only STARTED the job in the background — it returned before doing any work.",
        "You MUST call check_job_status with this jobId repeatedly until it reports status 'completed' or 'failed'; the actual result is delivered there.",
      ],
    });
  }
  return run();
}
