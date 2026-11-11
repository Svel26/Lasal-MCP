import { z } from "zod";
import { fromToolResponse } from "../../core/actions/legacy.js";
import { defineAction } from "../../core/actions/types.js";
import { hmiRuntimeHandler } from "../../tools/hmiRuntime.js";
import { inspectVisuProjectHandler } from "../../tools/inspectVisuProject.js";
import { manageVisuDesignerHandler } from "../../tools/lasalApps.js";
import { visuProjectHandler } from "../../tools/visuControl.js";

const lvpPath = z.string().optional().describe("Full path to the .lvp project file. Omit to use the selected project.");

function applyVisu(lvp_path: string | undefined, operations: unknown[]) {
  return visuProjectHandler({ action: "apply_changes", lvp_path, operations });
}

export const visuActions = [
  defineAction({
    id: "visu.project.inspect",
    aliases: ["inspect_visu_project", "inspect_visu"],
    domain: "visu",
    summary: "Inspect a VISUDesigner project: dashboards, datapoints, function blocks, code modules and metadata.",
    schema: z.object({
      lvp_path: lvpPath,
      scope: z
        .enum(["summary", "dashboards", "function_blocks", "code_modules", "datapoints", "dashboard_detail"])
        .optional()
        .default("summary")
        .describe("Detail scope to inspect."),
      filter: z.string().optional().describe("Regex for datapoint scan, or dashboard name for dashboard_detail."),
      limit: z.number().int().positive().optional().default(50).describe("Maximum datapoint matches (default 50)."),
    }),
    handler: async (params) => fromToolResponse(await inspectVisuProjectHandler(params)),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["visu", "inspect", "dashboards", "datapoints", "project"],
    examples: [
      { params: { scope: "summary" }, note: "Get a high-level inventory." },
      { params: { scope: "datapoints", filter: "Motor" }, note: "Find datapoints matching Motor." },
    ],
  }),

  defineAction({
    id: "visu.editor.open",
    aliases: ["manage_visudesigner_open", "open_visu"],
    domain: "visu",
    summary: "Open the VISUDesigner GUI for a project.",
    schema: z.object({
      lvp_path: lvpPath,
    }),
    handler: async (params) =>
      fromToolResponse(await manageVisuDesignerHandler({ action: "open", lvp_path: params.lvp_path })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["visu", "editor", "gui", "open"],
    examples: [{ params: {}, note: "Open the selected VISUDesigner project." }],
  }),

  defineAction({
    id: "visu.editor.close",
    aliases: ["manage_visudesigner_close", "close_visu"],
    domain: "visu",
    summary: "Close VISUDesigner, leaving instances opened for other projects running unless force is set.",
    schema: z.object({
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Close every VISUDesigner instance, including other projects."),
    }),
    handler: async (params) =>
      fromToolResponse(await manageVisuDesignerHandler({ action: "close", force: params.force })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    tags: ["visu", "editor", "gui", "close"],
    examples: [{ params: { force: false }, note: "Close only this project's VISUDesigner instances." }],
    hints: ["Close VISUDesigner before running automated visu engine operations."],
  }),

  defineAction({
    id: "visu.hmi.status",
    aliases: ["hmi_status", "hmi_runtime_status"],
    domain: "visu",
    summary: "Check whether the local VISU DataService HMI simulation is running.",
    schema: z.object({}),
    handler: async () => fromToolResponse(await hmiRuntimeHandler({ action: "status" })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["visu", "hmi", "runtime", "status"],
    examples: [{ params: {}, note: "Check the current HMI runtime state." }],
  }),

  defineAction({
    id: "visu.hmi.start",
    aliases: ["hmi_start", "hmi_runtime_start"],
    domain: "visu",
    summary: "Publish the VISU project and start the local DataService HMI web simulation.",
    schema: z.object({
      lvp_path: lvpPath,
      debugPublish: z
        .boolean()
        .optional()
        .default(true)
        .describe("Try a debug publish first, falling back to standard publish."),
      publishFirst: z
        .boolean()
        .optional()
        .default(true)
        .describe("Publish the project before starting the DataService."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await hmiRuntimeHandler({
          action: "start",
          lvp_path: params.lvp_path,
          debugPublish: params.debugPublish,
          publishFirst: params.publishFirst,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["visu", "hmi", "runtime", "start", "simulation"],
    examples: [{ params: {}, note: "Publish and start the local HMI simulation." }],
    hints: ["Returns an HTTP URL you can open in a browser or drive with Playwright."],
  }),

  defineAction({
    id: "visu.hmi.stop",
    aliases: ["hmi_stop", "hmi_runtime_stop"],
    domain: "visu",
    summary: "Stop the local VISU DataService HMI simulation.",
    schema: z.object({}),
    handler: async () => fromToolResponse(await hmiRuntimeHandler({ action: "stop" })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: false,
    tags: ["visu", "hmi", "runtime", "stop"],
    examples: [{ params: {}, note: "Stop the tracked HMI runtime." }],
  }),

  defineAction({
    id: "visu.publish",
    aliases: ["visu_publish", "publish_visu"],
    domain: "visu",
    summary: "Publish the VISUDesigner project.",
    schema: z.object({
      lvp_path: lvpPath,
      debug: z
        .boolean()
        .optional()
        .default(false)
        .describe("Publish with debug information (requires TypeScript support)."),
    }),
    handler: async (params) =>
      fromToolResponse(await applyVisu(params.lvp_path, [{ type: "publish", debug: params.debug }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["visu", "publish", "build", "engine"],
    examples: [
      { params: {}, note: "Standard publish." },
      { params: { debug: true }, note: "Debug publish for TS-enabled projects." },
    ],
  }),

  defineAction({
    id: "visu.download",
    aliases: ["visu_download", "download_visu"],
    domain: "visu",
    summary: "Download the VISUDesigner project to an HMI panel.",
    schema: z.object({
      lvp_path: lvpPath,
      connection: z.string().describe("HMI connection string, e.g. 'TCPIP:192.168.1.100'."),
      flags: z
        .number()
        .int()
        .optional()
        .default(0)
        .describe("Download mode: 0=normal, 1=changes only, 2=publish+download changes."),
      add_runtime: z.boolean().optional().default(false).describe("Force runtime download even when versions match."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await visuProjectHandler({
          action: "download",
          lvp_path: params.lvp_path,
          connection: params.connection,
          flags: params.flags,
          add_runtime: params.add_runtime,
        }),
      ),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["visu", "download", "deploy", "panel"],
    examples: [
      {
        params: { connection: "TCPIP:192.168.1.100" },
        note: "Download to the panel at 192.168.1.100.",
      },
    ],
  }),

  defineAction({
    id: "visu.textlist.export",
    aliases: ["visu_export_textlists", "export_visu_textlists"],
    domain: "visu",
    summary: "Export VISUDesigner text lists to a CSV file for translation.",
    schema: z.object({
      lvp_path: lvpPath,
      csv_path: z.string().describe("Destination CSV file path."),
      text_lists: z.array(z.string()).optional().describe("Subset of text list names to export (omit for all)."),
      languages: z.array(z.string()).optional().describe("Subset of language codes to export (omit for all)."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyVisu(params.lvp_path, [
          {
            type: "csv_export_text_lists",
            csv_path: params.csv_path,
            ...(params.text_lists ? { text_lists: params.text_lists } : {}),
            ...(params.languages ? { languages: params.languages } : {}),
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["visu", "textlist", "translation", "csv", "export"],
    examples: [
      {
        params: { csv_path: "C:\\Temp\\visu-texts.csv" },
        note: "Export all text lists to a CSV.",
      },
    ],
  }),

  defineAction({
    id: "visu.textlist.import",
    aliases: ["visu_import_textlists", "import_visu_textlists"],
    domain: "visu",
    summary: "Import translated VISUDesigner text lists from CSV files.",
    schema: z.object({
      lvp_path: lvpPath,
      file_paths: z.array(z.string()).min(1).describe("CSV file paths to import."),
      text_lists: z.array(z.string()).optional().describe("Subset of text list names to import (omit for all)."),
      languages: z.array(z.string()).optional().describe("Subset of language codes to import (omit for all)."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyVisu(params.lvp_path, [
          {
            type: "csv_import_text_lists",
            file_paths: params.file_paths,
            ...(params.text_lists ? { text_lists: params.text_lists } : {}),
            ...(params.languages ? { languages: params.languages } : {}),
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["visu", "textlist", "translation", "csv", "import"],
    examples: [
      {
        params: { file_paths: ["C:\\Temp\\visu-texts.csv"] },
        note: "Import all text lists from a CSV.",
      },
    ],
  }),

  defineAction({
    id: "visu.project.update_stations",
    aliases: ["visu_update_stations", "update_visu_stations"],
    domain: "visu",
    summary: "Update all VISU stations, or one station by number.",
    schema: z.object({
      lvp_path: lvpPath,
      station_nr: z.number().int().optional().describe("Station number to update. Omit to update all stations."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyVisu(
          params.lvp_path,
          params.station_nr === undefined
            ? [{ type: "update_all_stations" }]
            : [{ type: "update_station", station_nr: params.station_nr }],
        ),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["visu", "stations", "sync", "engine"],
    examples: [
      { params: {}, note: "Update all stations." },
      { params: { station_nr: 10 }, note: "Update station 10 only." },
    ],
  }),
];
