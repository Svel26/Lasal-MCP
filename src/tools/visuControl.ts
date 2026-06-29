import { existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";
import { readState } from "../state.js";
import { runVisuOps, VisuOp } from "../utils/visuScript.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function findLvpFiles(projectPath: string): string[] {
  const stationsDir = join(projectPath, "Stations");
  if (!existsSync(stationsDir)) return [];
  const lvpFiles: string[] = [];
  for (const type of readdirSync(stationsDir)) {
    const typeDir = join(stationsDir, type);
    if (!statSync(typeDir).isDirectory()) continue;
    for (const station of readdirSync(typeDir)) {
      const stationDir = join(typeDir, station);
      if (!statSync(stationDir).isDirectory()) continue;
      for (const file of readdirSync(stationDir)) {
        if (file.endsWith(".lvp")) lvpFiles.push(join(stationDir, file));
      }
    }
  }
  return lvpFiles;
}

function resolveLvpPath(lvpPath?: string): { path: string } | { error: string } {
  if (lvpPath) {
    if (!existsSync(lvpPath)) return { error: `File not found: ${lvpPath}` };
    return { path: lvpPath };
  }
  const state = readState();
  if (!state.currentProject) return { error: "No project selected. Call select_project first." };
  const found = findLvpFiles(state.currentProject);
  if (found.length === 0) return { error: `No .lvp files found in ${state.currentProject}` };
  if (found.length === 1) return { path: found[0] };
  return {
    error: `Multiple .lvp stations found — specify lvp_path:\n${found.map((f) => `  ${f}`).join("\n")}`,
  };
}

function visuResultToResponse(r: ReturnType<typeof runVisuOps>, extra?: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    ok: r.ok,
    durationMs: r.durationMs,
    ...(r.errors.length ? { errors: r.errors } : {}),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
    logPath: r.logPath,
    ...extra,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(r.ok ? {} : { isError: true }),
  };
}

// ── Operation schemas ─────────────────────────────────────────────────────────

// Shared sub-schemas
const textEntrySchema = z
  .record(z.string(), z.string())
  .refine((v) => "id" in v, { message: 'Each text entry must have an "id" field' })
  .describe('Text entry: { "id": "KEY", "De": "German text", "En": "English text", ... }');

const textListDefSchema = z.object({
  name: z.string().describe("Text list name"),
  texts: z.array(textEntrySchema).optional().describe("Text entries with translations per language"),
  revision: z.string().optional().describe("Revision string, e.g. '1.0'"),
});

const textListRemoveDefSchema = z.object({
  name: z.string(),
  ids: z.array(z.string()).describe("IDs of texts to remove"),
});

const propertySetDefSchema = z.object({
  element: z.string().describe("Datapoint / datatype / scheme name"),
  property: z
    .string()
    .describe(
      "Property constant, e.g. 'AliasName', 'RefreshTime', 'WriteProtected', 'LimitLow', 'LimitHigh', 'Unit', 'Keyboard', 'EnumValue', 'InitValue'"
    ),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .describe("Value to set. Numbers and booleans are auto-converted to strings by the API."),
});

const schemeEntryDefSchema = z.object({
  position: z.number().int().describe("0-based position in the scheme"),
  property: z
    .string()
    .optional()
    .describe("Entry property to set, e.g. 'SetValue', 'CompareValue', 'Operator'"),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .optional()
    .describe("Value to set for the property"),
  new_position: z.number().int().optional().describe("Target position for move operations"),
});

const schemeTypeDesc =
  "Scheme type constant: 'ColorScheme', 'StateScheme', 'FontStyleScheme', 'KeyboardScheme', 'KeyboardLayoutScheme', 'MediaScheme', 'NavigationScheme', 'TextScheme', 'UnitScheme', 'DatapointScheme', 'CompositeControlScheme'";

const schemeDefSchema = z.object({
  scheme_type: z.string().describe(schemeTypeDesc),
  name: z.string().describe("Scheme name"),
  input: z.string().optional().describe("Input datapoint name for the scheme"),
  entries: z.array(schemeEntryDefSchema).optional().describe("Scheme entries"),
  positions: z.array(z.number().int()).optional().describe("Entry positions (for remove_scheme_entries)"),
  moves: z
    .array(z.object({ from: z.number().int(), to: z.number().int() }))
    .optional()
    .describe("Move operations (for move_scheme_entries)"),
});

const mediaItemDefSchema = z.object({
  media_type: z
    .string()
    .describe("Media type: 'Image', 'Video', 'Audio', 'Docs', 'Fonts', 'KeyboardLayouts', 'Other'"),
  path: z.string().optional().describe("Full file path (for add operations)"),
  name: z.string().optional().describe("File name including extension (for remove operations)"),
});

// Individual op schemas
const UpdateAllStationsOp = z.object({ type: z.literal("update_all_stations") });

const AddTextListsOp = z.object({
  type: z.literal("add_text_lists"),
  text_lists: z.array(textListDefSchema).describe("Text lists to add (optionally with texts and revisions)"),
});

const RemoveTextListsOp = z.object({
  type: z.literal("remove_text_lists"),
  names: z.array(z.string()).describe("Names of text lists to remove"),
});

const AddTextsOp = z.object({
  type: z.literal("add_texts"),
  text_lists: z.array(textListDefSchema).describe("Text lists with texts to add"),
});

const RemoveTextsOp = z.object({
  type: z.literal("remove_texts"),
  text_lists: z.array(textListRemoveDefSchema).describe("Text lists with text IDs to remove"),
});

const ChangeTextsOp = z.object({
  type: z.literal("change_texts"),
  text_lists: z.array(textListDefSchema).describe("Text lists with updated text values"),
});

const ChangeComponentTextsOp = z.object({
  type: z.literal("change_component_texts"),
  text_lists: z.array(textListDefSchema).describe("Component text lists with updated text values"),
});

const CsvExportTextListsOp = z.object({
  type: z.literal("csv_export_text_lists"),
  csv_path: z.string().describe("Destination CSV file path"),
  text_lists: z.array(z.string()).optional().describe("Subset of text list names to export (omit for all)"),
  languages: z.array(z.string()).optional().describe("Subset of language codes to export (omit for all)"),
});

const CsvImportTextListsOp = z.object({
  type: z.literal("csv_import_text_lists"),
  file_paths: z.array(z.string()).describe("CSV file paths to import from"),
  text_lists: z.array(z.string()).optional().describe("Subset of text list names to import (omit for all)"),
  languages: z.array(z.string()).optional().describe("Subset of language codes to import (omit for all)"),
});

const CsvExportComponentTextListsOp = z.object({
  type: z.literal("csv_export_component_text_lists"),
  csv_path: z.string().describe("Destination CSV file path"),
  text_lists: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
});

const CsvImportComponentTextListsOp = z.object({
  type: z.literal("csv_import_component_text_lists"),
  file_paths: z.array(z.string()),
  text_lists: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
});

const SetDatapointPropertiesOp = z.object({
  type: z.literal("set_datapoint_properties"),
  properties: z
    .array(propertySetDefSchema)
    .describe(
      "List of property sets. Use property constants: AliasName, RefreshTime (High/Medium/Low/Standard), WriteProtected, AccessNumber, LimitLow, LimitHigh, Unit, Keyboard, EnumValue, InitValue, etc."
    ),
});

const SetDataTypePropertiesOp = z.object({
  type: z.literal("set_datatype_properties"),
  properties: z.array(propertySetDefSchema),
});

const AddSchemesOp = z.object({
  type: z.literal("add_schemes"),
  schemes: z
    .array(schemeDefSchema)
    .describe("Schemes to add. Entries and input can be specified to set them simultaneously."),
});

const RemoveSchemesOp = z.object({
  type: z.literal("remove_schemes"),
  schemes: z
    .array(z.object({ scheme_type: z.string().describe(schemeTypeDesc), name: z.string() }))
    .describe("Schemes to remove"),
});

const AddSchemeEntriesOp = z.object({
  type: z.literal("add_scheme_entries"),
  schemes: z
    .array(schemeDefSchema)
    .describe(
      "Schemes with entries to add. Position determines insertion point; entries beyond max are appended."
    ),
});

const RemoveSchemeEntriesOp = z.object({
  type: z.literal("remove_scheme_entries"),
  schemes: z
    .array(schemeDefSchema)
    .describe("Schemes with positions to remove. Use 'positions' or 'entries[].position'."),
});

const MoveSchemeEntriesOp = z.object({
  type: z.literal("move_scheme_entries"),
  schemes: z
    .array(schemeDefSchema)
    .describe("Schemes with move operations. Use 'moves': [{from: N, to: M}, ...]"),
});

const SetSchemeInputsOp = z.object({
  type: z.literal("set_scheme_inputs"),
  schemes: z
    .array(schemeDefSchema)
    .describe("Schemes with the 'input' field set to the datapoint name to use as input"),
});

const SetSchemePropertiesOp = z.object({
  type: z.literal("set_scheme_properties"),
  scheme_type: z.string().describe(schemeTypeDesc),
  properties: z
    .array(propertySetDefSchema)
    .describe(
      "PropertySets where 'element' is the scheme name. Available properties: Revision, LockOverloadCompareValue, LockOverloadSetValue"
    ),
});

const SetSchemeEntryPropertiesOp = z.object({
  type: z.literal("set_scheme_entry_properties"),
  schemes: z
    .array(schemeDefSchema)
    .describe(
      "Schemes with entries where each entry specifies position + property + value to set. " +
        "Entry properties: Operator (<,<=,=,>=,>,<>), CompareValue, SetValue. " +
        "For StateScheme SetValue: None, Active, Inactive, Invisible."
    ),
});

const AddMediaItemsOp = z.object({
  type: z.literal("add_media_items"),
  items: z
    .array(mediaItemDefSchema)
    .describe("Media items to add. Each needs media_type and path (full file path)."),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overwrite existing items with the same name"),
});

const RemoveMediaItemsOp = z.object({
  type: z.literal("remove_media_items"),
  items: z
    .array(mediaItemDefSchema)
    .describe("Media items to remove. Each needs media_type and name (filename + extension)."),
});

const AddCodeModulesOp = z.object({
  type: z.literal("add_code_modules"),
  paths: z.array(z.string()).describe("Full paths to code module files (.js or .ts) to add"),
});

const RemoveCodeModulesOp = z.object({
  type: z.literal("remove_code_modules"),
  names: z.array(z.string()).describe("File names (with extension) of code modules to remove"),
});

const UpdatePropertyValuesOp = z.object({
  type: z.literal("update_property_values"),
});

const DownloadOp = z.object({
  type: z.literal("download"),
  connection: z
    .string()
    .describe(
      "Connection string, e.g. 'TCPIP:192.168.1.100' or 'TCPIP:myhmi.local'. Use the 'TCPIP:' prefix for IP/DNS targets."
    ),
  flags: z
    .number()
    .int()
    .optional()
    .default(0)
    .describe("Download mode: 0=normal (default), 1=changes only, 2=publish+download changes"),
  add_runtime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force runtime download even if version matches"),
});

const OperationSchema = z.discriminatedUnion("type", [
  UpdateAllStationsOp,
  AddTextListsOp, RemoveTextListsOp,
  AddTextsOp, RemoveTextsOp, ChangeTextsOp, ChangeComponentTextsOp,
  CsvExportTextListsOp, CsvImportTextListsOp,
  CsvExportComponentTextListsOp, CsvImportComponentTextListsOp,
  SetDatapointPropertiesOp, SetDataTypePropertiesOp,
  AddSchemesOp, RemoveSchemesOp,
  AddSchemeEntriesOp, RemoveSchemeEntriesOp, MoveSchemeEntriesOp,
  SetSchemeInputsOp, SetSchemePropertiesOp, SetSchemeEntryPropertiesOp,
  AddMediaItemsOp, RemoveMediaItemsOp,
  AddCodeModulesOp, RemoveCodeModulesOp,
  UpdatePropertyValuesOp,
  DownloadOp,
]);

type Operation = z.infer<typeof OperationSchema>;

// ── apply_visu_changes ────────────────────────────────────────────────────────

export const applyVisuChangesSchema = {
  lvp_path: z
    .string()
    .optional()
    .describe(
      "Full path to the .lvp project file. Omit to auto-detect from the selected project (fails if multiple stations)."
    ),
  operations: z
    .array(z.any())
    .describe(
      "Ordered list of VISUDesigner operations. Each has a 'type' field. " +
        "The project is loaded, all operations are applied, then saved and closed. " +
        "Available types: update_all_stations | add_text_lists | remove_text_lists | add_texts | " +
        "remove_texts | change_texts | change_component_texts | csv_export_text_lists | " +
        "csv_import_text_lists | csv_export_component_text_lists | csv_import_component_text_lists | " +
        "set_datapoint_properties | set_datatype_properties | add_schemes | remove_schemes | " +
        "add_scheme_entries | remove_scheme_entries | move_scheme_entries | set_scheme_inputs | " +
        "set_scheme_properties | set_scheme_entry_properties | add_media_items | remove_media_items | " +
        "add_code_modules | remove_code_modules | update_property_values | download"
    ),
};

export async function applyVisuChangesHandler(args: { lvp_path?: string; operations: unknown[] }) {
  const resolved = resolveLvpPath(args.lvp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
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
    return {
      content: [{ type: "text" as const, text: `Invalid operations:\n${parseErrors.join("\n")}` }],
      isError: true,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visuOps: VisuOp[] = (ops as any[]).map((op: any): VisuOp => {
    switch (op.type) {
      case "update_all_stations":
        return { type: "update_all_stations" as const };
      case "add_text_lists":
        return { type: "add_text_lists" as const, text_lists: op.text_lists };
      case "remove_text_lists":
        return { type: "remove_text_lists" as const, names: op.names };
      case "add_texts":
        return { type: "add_texts" as const, text_lists: op.text_lists };
      case "remove_texts":
        return { type: "remove_texts" as const, text_lists: op.text_lists };
      case "change_texts":
        return { type: "change_texts" as const, text_lists: op.text_lists };
      case "change_component_texts":
        return { type: "change_component_texts" as const, text_lists: op.text_lists };
      case "csv_export_text_lists":
        return { type: "csv_export_text_lists" as const, csv_path: op.csv_path, text_lists: op.text_lists, languages: op.languages };
      case "csv_import_text_lists":
        return { type: "csv_import_text_lists" as const, file_paths: op.file_paths, text_lists: op.text_lists, languages: op.languages };
      case "csv_export_component_text_lists":
        return { type: "csv_export_component_text_lists" as const, csv_path: op.csv_path, text_lists: op.text_lists, languages: op.languages };
      case "csv_import_component_text_lists":
        return { type: "csv_import_component_text_lists" as const, file_paths: op.file_paths, text_lists: op.text_lists, languages: op.languages };
      case "set_datapoint_properties":
        return { type: "set_datapoint_properties" as const, properties: op.properties };
      case "set_datatype_properties":
        return { type: "set_datatype_properties" as const, properties: op.properties };
      case "add_schemes":
        return { type: "add_schemes" as const, schemes: op.schemes };
      case "remove_schemes":
        return { type: "remove_schemes" as const, schemes: op.schemes };
      case "add_scheme_entries":
        return { type: "add_scheme_entries" as const, schemes: op.schemes };
      case "remove_scheme_entries":
        return { type: "remove_scheme_entries" as const, schemes: op.schemes };
      case "move_scheme_entries":
        return { type: "move_scheme_entries" as const, schemes: op.schemes };
      case "set_scheme_inputs":
        return { type: "set_scheme_inputs" as const, schemes: op.schemes };
      case "set_scheme_properties":
        return { type: "set_scheme_properties" as const, scheme_type: op.scheme_type, properties: op.properties };
      case "set_scheme_entry_properties":
        return { type: "set_scheme_entry_properties" as const, schemes: op.schemes };
      case "add_media_items":
        return { type: "add_media_items" as const, items: op.items, overwrite: op.overwrite };
      case "remove_media_items":
        return { type: "remove_media_items" as const, items: op.items };
      case "add_code_modules":
        return { type: "add_code_modules" as const, paths: op.paths };
      case "remove_code_modules":
        return { type: "remove_code_modules" as const, names: op.names };
      case "update_property_values":
        return { type: "update_property_values" as const };
      case "download":
        return { type: "download" as const, connection: op.connection, flags: op.flags, add_runtime: op.add_runtime };
      default:
        throw new Error(`Unknown operation type: ${op.type}`);
    }
  });

  const r = runVisuOps(resolved.path, visuOps);
  return visuResultToResponse(r, { lvpPath: resolved.path });
}

// ── download_visu_project ─────────────────────────────────────────────────────

export const downloadVisuProjectSchema = {
  lvp_path: z
    .string()
    .optional()
    .describe("Full path to the .lvp file. Omit to auto-detect from the selected project."),
  connection: z
    .string()
    .describe("HMI connection string, e.g. 'TCPIP:192.168.1.100' or 'TCPIP:myhmi.local'"),
  flags: z
    .number()
    .int()
    .optional()
    .default(0)
    .describe("0=normal (default), 1=changes only, 2=publish+download changes"),
  add_runtime: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force runtime download even if version already matches"),
};

export async function downloadVisuProjectHandler(args: {
  lvp_path?: string;
  connection: string;
  flags?: number;
  add_runtime?: boolean;
}) {
  const resolved = resolveLvpPath(args.lvp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const r = runVisuOps(
    resolved.path,
    [{ type: "download", connection: args.connection, flags: args.flags ?? 0, add_runtime: args.add_runtime ?? false }],
    false  // no save — download only, no content changes
  );
  return visuResultToResponse(r, { lvpPath: resolved.path, connection: args.connection });
}
