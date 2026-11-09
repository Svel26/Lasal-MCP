import { z } from "zod";
import { fromToolResponse } from "../../core/actions/legacy.js";
import { defineAction } from "../../core/actions/types.js";
import { manageLasalScreenHandler } from "../../tools/lasalApps.js";
import { lseProjectHandler, lseProjectSchema } from "../../tools/lseProject.js";

const lprPath = z.string().optional().describe("Full path to the .lpr project. Omit to use the selected project.");

const buttonUpdateSchema = z.object({
  property: z
    .union([z.string(), z.number().int()])
    .describe(
      "LSButtonProperty constant (name or number): Doubleclick=1, Theme=2, ColorBackground=3, Fill=4, Text=5, TopLeft=6, BottomRight=7, Zoom=8.",
    ),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("New property value."),
  inverse: z.boolean().optional().describe("Invert theme imaging where supported."),
});

const settingsSchema = z.object({
  screen_width: z.number().int().optional(),
  screen_height: z.number().int().optional(),
  target_width: z.number().int().optional(),
  target_height: z.number().int().optional(),
  compiler_warnings: z.boolean().optional(),
  compiler_version: z.number().int().optional().describe("LSE compiler version, e.g. 60."),
  online_ip: z.string().optional().describe("Online/download target IP."),
  online_connection: z.string().optional().describe("Address-book connection name."),
});

function applyLse(lpr_path: string | undefined, operations: unknown[], save = true) {
  return lseProjectHandler({ action: "apply_changes", lpr_path, operations, save });
}

export const screenActions = [
  defineAction({
    id: "screen.project.info",
    aliases: ["lse_info", "screen_info"],
    domain: "screen",
    summary: "Inventory a LASAL SCREEN project: screens, windows, servers, text lists, languages and settings.",
    schema: z.object({ lpr_path: lprPath }),
    handler: async (params) => fromToolResponse(await lseProjectHandler({ action: "info", lpr_path: params.lpr_path })),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["screen", "lse", "project", "inspect", "info"],
    examples: [{ params: {}, note: "Inspect the selected screen project." }],
  }),

  defineAction({
    id: "screen.project.create",
    aliases: ["lse_create", "create_screen_project"],
    domain: "screen",
    summary: "Create a new empty LASAL SCREEN .lpr project.",
    schema: z.object({
      lpr_path: z.string().describe("Destination .lpr path for the new project."),
    }),
    handler: async (params) =>
      fromToolResponse(await lseProjectHandler({ action: "create", lpr_path: params.lpr_path })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["screen", "lse", "project", "create"],
    examples: [{ params: { lpr_path: "C:\\Projects\\Panel\\Panel.lpr" }, note: "Create an empty panel project." }],
  }),

  defineAction({
    id: "screen.project.compile",
    aliases: ["lse_compile", "compile_screen"],
    domain: "screen",
    summary: "Compile the LASAL SCREEN project into its Runtime output folder.",
    schema: z.object({
      lpr_path: lprPath,
      timeout_s: z.number().int().positive().optional().describe("Compile timeout in seconds."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await lseProjectHandler({
          action: "compile",
          lpr_path: params.lpr_path,
          timeout_s: params.timeout_s,
        }),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "compile", "build"],
    examples: [{ params: {}, note: "Compile the selected screen project." }],
  }),

  defineAction({
    id: "screen.project.download",
    aliases: ["lse_download", "download_screen"],
    domain: "screen",
    summary: "Download the screen project to a panel and optionally start it.",
    schema: z.object({
      lpr_path: lprPath,
      connection: z.string().optional().describe("Download target, e.g. 'TCPIP:192.168.1.50'."),
      run: z.boolean().optional().default(true).describe("Start the screen runtime after transfer."),
      timeout_s: z.number().int().positive().optional().describe("Download timeout in seconds."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await lseProjectHandler({
          action: "download",
          lpr_path: params.lpr_path,
          connection: params.connection,
          run: params.run,
          timeout_s: params.timeout_s,
        }),
      ),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "download", "deploy", "panel"],
    examples: [{ params: {}, note: "Download using the .lss target of the station owning the .lpr." }],
  }),

  defineAction({
    id: "screen.project.apply_changes",
    aliases: ["lse_apply_changes", "screen_apply"],
    domain: "screen",
    summary: "Apply an ordered list of LASAL SCREEN operations to a project.",
    schema: z.object({
      lpr_path: lprPath,
      operations: lseProjectSchema.operations,
      save: z.boolean().optional().default(true).describe("Save after applying the operations."),
    }),
    handler: async (params) =>
      fromToolResponse(await applyLse(params.lpr_path, params.operations ?? [], params.save ?? true)),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "apply", "operations", "engine"],
    examples: [
      {
        params: { operations: [{ type: "compile" }] },
        note: "Compile via the operations list.",
      },
    ],
  }),

  defineAction({
    id: "screen.project.merge",
    aliases: ["lse_merge", "merge_screen_project"],
    domain: "screen",
    summary: "Merge a screen project/export file into the open project.",
    schema: z.object({
      lpr_path: lprPath,
      file: z.string().describe("Project/export file to merge."),
      overwrite: z.boolean().optional().default(true),
      deep_merge: z.boolean().optional(),
      skip_global_screen: z.boolean().optional(),
      screen_x_offset: z.number().int().optional(),
      screen_y_offset: z.number().int().optional(),
      softkey_offset: z.number().int().optional(),
      softkey_valid: z.boolean().optional(),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          {
            type: "merge",
            file: params.file,
            overwrite: params.overwrite,
            deep_merge: params.deep_merge,
            skip_global_screen: params.skip_global_screen,
            screen_x_offset: params.screen_x_offset,
            screen_y_offset: params.screen_y_offset,
            softkey_offset: params.softkey_offset,
            softkey_valid: params.softkey_valid,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "merge", "project"],
    examples: [{ params: { file: "C:\\Temp\\export.lpr" }, note: "Merge an exported project." }],
  }),

  defineAction({
    id: "screen.project.fuse",
    aliases: ["lse_fuse", "fuse_screen_project"],
    domain: "screen",
    summary: "Apply a fuse file with critical changes to the screen project.",
    schema: z.object({
      lpr_path: lprPath,
      file: z.string().describe("Fuse file to apply."),
      critical_changes: z.boolean().optional().default(true),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          { type: "fuse", file: params.file, critical_changes: params.critical_changes },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "fuse", "project"],
    examples: [{ params: { file: "C:\\Temp\\fuse.fus" }, note: "Apply a fuse file." }],
  }),

  defineAction({
    id: "screen.text.export_xml",
    aliases: ["lse_export_xml", "export_screen_texts"],
    domain: "screen",
    summary: "Export screen texts to an XML file.",
    schema: z.object({
      lpr_path: lprPath,
      path: z.string().describe("Destination XML path."),
      overwrite: z.boolean().optional().default(true),
      languages: z.array(z.number().int()).optional().describe("LCIDs to include."),
      container_info: z.boolean().optional(),
      sorted_array: z.boolean().optional(),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          {
            type: "export_xml",
            path: params.path,
            overwrite: params.overwrite,
            languages: params.languages,
            container_info: params.container_info,
            sorted_array: params.sorted_array,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "text", "xml", "export"],
    examples: [{ params: { path: "C:\\Temp\\screen-texts.xml" }, note: "Export all texts." }],
  }),

  defineAction({
    id: "screen.text.import_xml",
    aliases: ["lse_import_xml", "import_screen_texts"],
    domain: "screen",
    summary: "Import screen texts from an XML file.",
    schema: z.object({
      lpr_path: lprPath,
      path: z.string().describe("XML text file to import."),
    }),
    handler: async (params) =>
      fromToolResponse(await applyLse(params.lpr_path, [{ type: "import_xml", path: params.path }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "text", "xml", "import"],
    examples: [{ params: { path: "C:\\Temp\\screen-texts.xml" }, note: "Import texts." }],
  }),

  defineAction({
    id: "screen.variables.import",
    aliases: ["lse_import_variables", "import_screen_variables"],
    domain: "screen",
    summary: "Import CLASS 2 variables into the screen project.",
    schema: z.object({
      lpr_path: lprPath,
      file: z.string().describe("Variable import file from CLASS 2."),
      station_number: z.number().int().min(0).max(255).describe("Station number of the PLC providing the variables."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          { type: "import_variables", file: params.file, station_number: params.station_number },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "variables", "import", "class2"],
    examples: [
      {
        params: { file: "C:\\Temp\\MaeExp.txt", station_number: 10 },
        note: "Import variables from station 10.",
      },
    ],
  }),

  defineAction({
    id: "screen.textlist.create",
    aliases: ["lse_create_textlist", "create_screen_textlist"],
    domain: "screen",
    summary: "Create a text list in the screen project.",
    schema: z.object({
      lpr_path: lprPath,
      name: z.string().describe("Text list name."),
      text: z.string().optional().describe("Initial text."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [{ type: "textlist_create", name: params.name, text: params.text }]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "textlist", "create"],
    examples: [{ params: { name: "Alarms" }, note: "Create an empty text list." }],
  }),

  defineAction({
    id: "screen.textlist.import",
    aliases: ["lse_import_textlist", "import_screen_textlist"],
    domain: "screen",
    summary: "Import texts into a screen text list.",
    schema: z.object({
      lpr_path: lprPath,
      text_list: z.string().describe("Target text list."),
      file: z.string().describe("Text export file."),
      language_id: z.number().int().optional().describe("LCID the texts belong to."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          {
            type: "textlist_import",
            text_list: params.text_list,
            file: params.file,
            language_id: params.language_id,
          },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "textlist", "import", "translation"],
    examples: [{ params: { text_list: "Alarms", file: "C:\\Temp\\alarms.txt" }, note: "Import texts into a list." }],
  }),

  defineAction({
    id: "screen.textlist.get_texts",
    aliases: ["lse_get_texts", "get_screen_texts"],
    domain: "screen",
    summary: "Read the texts of a screen text list.",
    schema: z.object({
      lpr_path: lprPath,
      text_list: z.string().describe("Text list name."),
      languages: z.array(z.number().int()).optional().describe("LCIDs to read. Omit for all languages."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(
          params.lpr_path,
          [{ type: "textlist_get_texts", text_list: params.text_list, languages: params.languages }],
          false,
        ),
      ),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "textlist", "read", "translation"],
    examples: [{ params: { text_list: "Alarms" }, note: "Read all translations of a list." }],
  }),

  defineAction({
    id: "screen.language.add",
    aliases: ["lse_add_language", "add_screen_language"],
    domain: "screen",
    summary: "Add a language to the screen project.",
    schema: z.object({
      lpr_path: lprPath,
      language_id: z.number().int().describe("LCID, e.g. 2057 (English/UK)."),
    }),
    handler: async (params) =>
      fromToolResponse(await applyLse(params.lpr_path, [{ type: "add_language", language_id: params.language_id }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "language", "add"],
    examples: [{ params: { language_id: 2057 }, note: "Add English/UK." }],
  }),

  defineAction({
    id: "screen.settings.set",
    aliases: ["lse_settings", "set_screen_settings"],
    domain: "screen",
    summary: "Update screen project settings (resolution, compiler, online target).",
    schema: z.object({
      lpr_path: lprPath,
      settings: settingsSchema,
    }),
    handler: async (params) =>
      fromToolResponse(await applyLse(params.lpr_path, [{ type: "settings_set", settings: params.settings }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "settings", "resolution", "compiler", "online"],
    examples: [{ params: { settings: { screen_width: 800, screen_height: 480 } }, note: "Set the screen resolution." }],
  }),

  defineAction({
    id: "screen.image.insert",
    aliases: ["lse_insert_image", "insert_screen_image"],
    domain: "screen",
    summary: "Insert an image into the screen project.",
    schema: z.object({
      lpr_path: lprPath,
      file: z.string().describe("BMP image path."),
      transparent_rgb: z.number().int().optional().describe("Transparent color as an RGB integer."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          { type: "image_insert", file: params.file, transparent_rgb: params.transparent_rgb },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "image", "insert", "media"],
    examples: [{ params: { file: "C:\\Temp\\logo.bmp" }, note: "Insert a BMP image." }],
  }),

  defineAction({
    id: "screen.server.get_property",
    aliases: ["lse_get_server_property", "get_screen_server_property"],
    domain: "screen",
    summary: "Read a property of a screen server (limits, unit, menu, state schema, hostname, ...).",
    schema: z.object({
      lpr_path: lprPath,
      server: z.string().describe("Server name from 'info'."),
      property: z.union([z.string(), z.number().int()]).describe("LSServerProperty name or number."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(
          params.lpr_path,
          [{ type: "server_get_property", server: params.server, property: params.property }],
          false,
        ),
      ),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "server", "property", "read"],
    examples: [{ params: { server: "Motor1.s_Speed", property: "unit" }, note: "Read a server property." }],
  }),

  defineAction({
    id: "screen.server.set_property",
    aliases: ["lse_set_server_property", "set_screen_server_property"],
    domain: "screen",
    summary: "Set a property of a screen server.",
    schema: z.object({
      lpr_path: lprPath,
      server: z.string().describe("Server name from 'info'."),
      property: z.union([z.string(), z.number().int()]).describe("LSServerProperty name or number."),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("New value."),
    }),
    handler: async (params) =>
      fromToolResponse(
        await applyLse(params.lpr_path, [
          { type: "server_set_property", server: params.server, property: params.property, value: params.value },
        ]),
      ),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "server", "property", "write"],
    examples: [{ params: { server: "Motor1.s_Speed", property: "unit", value: "rpm" }, note: "Set the unit." }],
  }),

  defineAction({
    id: "screen.buttons.update",
    aliases: ["lse_update_buttons", "theme_screen_buttons"],
    domain: "screen",
    summary: "Bulk-update placed button properties (theme, colors, zoom).",
    schema: z.object({
      lpr_path: lprPath,
      updates: z.array(buttonUpdateSchema).min(1).describe("Property updates for all placed buttons."),
    }),
    handler: async (params) =>
      fromToolResponse(await applyLse(params.lpr_path, [{ type: "update_buttons", updates: params.updates }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "buttons", "theme", "bulk"],
    examples: [{ params: { updates: [{ property: "Theme", value: 3 }] }, note: "Apply theme 3 to all buttons." }],
  }),

  defineAction({
    id: "screen.softkeys.update",
    aliases: ["lse_update_softkeys", "theme_screen_softkeys"],
    domain: "screen",
    summary: "Bulk-update softkey properties.",
    schema: z.object({
      lpr_path: lprPath,
      updates: z.array(buttonUpdateSchema).min(1).describe("Property updates for all softkeys."),
    }),
    handler: async (params) =>
      fromToolResponse(await applyLse(params.lpr_path, [{ type: "update_softkeys", updates: params.updates }])),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    asyncCapable: true,
    tags: ["screen", "lse", "softkeys", "theme", "bulk"],
    examples: [{ params: { updates: [{ property: "Theme", value: 2 }] }, note: "Apply theme 2 to all softkeys." }],
  }),

  defineAction({
    id: "screen.editor.open",
    aliases: ["manage_lasalscreen_open", "open_screen_editor"],
    domain: "screen",
    summary: "Open the LASAL SCREEN editor for a .lpr project.",
    schema: z.object({ lpr_path: lprPath }),
    handler: async (params) =>
      fromToolResponse(await manageLasalScreenHandler({ action: "open", lpr_path: params.lpr_path })),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["screen", "lse", "editor", "gui", "open"],
    examples: [{ params: {}, note: "Open the selected screen project." }],
  }),

  defineAction({
    id: "screen.editor.close",
    aliases: ["manage_lasalscreen_close", "close_screen_editor"],
    domain: "screen",
    summary: "Close the LASAL SCREEN editor and release .lpr locks.",
    schema: z.object({}),
    handler: async () => fromToolResponse(await manageLasalScreenHandler({ action: "close" })),
    risk: "destructive",
    destructive: true,
    requiresConfirm: true,
    requiresProject: false,
    tags: ["screen", "lse", "editor", "gui", "close"],
    examples: [{ params: {}, note: "Close the LASAL SCREEN editor." }],
  }),
];
