import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync, execFileSync } from "child_process";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const VISUDESIGNER_EXE =
  process.env.LASAL_VISUDESIGNER_EXE ||
  "C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe";

const SCRATCH = join(tmpdir(), "lasal-mcp");

export interface VisuResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
  errors: string[];
  warnings: string[];
  durationMs: number;
}

// ── Input shape types (what the MCP tool accepts) ─────────────────────────────

export type TextEntry = Record<string, string>;

export interface TextListDef {
  name: string;
  texts?: TextEntry[];
  revision?: string;
}

export interface TextListRemoveDef {
  name: string;
  ids: string[];
}

export interface PropertySetDef {
  element: string;
  property: string;
  value: string | number | boolean | null;
}

export interface SchemeEntryDef {
  position: number;
  property?: string;
  value?: string | number | boolean | null;
  new_position?: number;
}

export interface SchemeDef {
  scheme_type: string;
  name: string;
  input?: string;
  entries?: SchemeEntryDef[];
  positions?: number[];
  moves?: Array<{ from: number; to: number }>;
}

export interface MediaItemDef {
  media_type: string;
  path?: string;
  name?: string;
}

export type VisuOp =
  | { type: "update_all_stations" }
  | { type: "update_station"; station_nr: number }
  | { type: "publish"; debug?: boolean }
  | { type: "add_text_lists"; text_lists: TextListDef[] }
  | { type: "remove_text_lists"; names: string[] }
  | { type: "add_texts"; text_lists: TextListDef[] }
  | { type: "remove_texts"; text_lists: TextListRemoveDef[] }
  | { type: "change_texts"; text_lists: TextListDef[] }
  | { type: "change_component_texts"; text_lists: TextListDef[] }
  | { type: "set_text_list_revisions"; text_lists: TextListDef[] }
  | { type: "set_component_text_list_revisions"; text_lists: TextListDef[] }
  | { type: "csv_export_text_lists"; csv_path: string; text_lists?: string[]; languages?: string[] }
  | { type: "csv_import_text_lists"; file_paths: string[]; text_lists?: string[]; languages?: string[] }
  | { type: "csv_export_component_text_lists"; csv_path: string; text_lists?: string[]; languages?: string[] }
  | { type: "csv_import_component_text_lists"; file_paths: string[]; text_lists?: string[]; languages?: string[] }
  | { type: "set_datapoint_properties"; properties: PropertySetDef[] }
  | { type: "set_datatype_properties"; properties: PropertySetDef[] }
  | { type: "add_schemes"; schemes: SchemeDef[] }
  | { type: "remove_schemes"; schemes: Array<{ scheme_type: string; name: string }> }
  | { type: "add_scheme_entries"; schemes: SchemeDef[] }
  | { type: "remove_scheme_entries"; schemes: SchemeDef[] }
  | { type: "move_scheme_entries"; schemes: SchemeDef[] }
  | { type: "set_scheme_inputs"; schemes: SchemeDef[] }
  | { type: "set_scheme_properties"; scheme_type: string; properties: PropertySetDef[] }
  | { type: "set_scheme_entry_properties"; schemes: SchemeDef[] }
  | { type: "add_media_items"; items: MediaItemDef[]; overwrite?: boolean }
  | { type: "remove_media_items"; items: MediaItemDef[] }
  | { type: "add_code_modules"; paths: string[] }
  | { type: "remove_code_modules"; names: string[] }
  | { type: "update_property_values" }
  | { type: "download"; connection: string; flags?: number; add_runtime?: boolean };

// ── Python 3.12 emission helpers ──────────────────────────────────────────────

function emitStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

function emitPyScalar(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  return emitStr(String(v));
}

function emitStrList(arr: string[]): string {
  return `[${arr.map(emitStr).join(", ")}]`;
}

function emitOptStrList(arr: string[] | undefined): string {
  return arr && arr.length > 0 ? emitStrList(arr) : "None";
}

// Emits one or more TextElement calls for a single text entry
// { id: "K1", De: "Hallo", En: "Hello" } → TextElement calls per language
function emitTextElementsForEntry(entry: TextEntry): string[] {
  const { id, ...langs } = entry;
  const langKeys = Object.keys(langs).filter((k) => langs[k] !== undefined);
  if (langKeys.length === 0) {
    return [`lvd.TextElement(${emitStr(id)})`];
  }
  return langKeys.map((lang) => `lvd.TextElement(${emitStr(id)}, ${emitStr(lang)}, ${emitStr(langs[lang])})`);
}

function emitTextList(def: TextListDef): string {
  let elements = "None";
  if (def.texts && def.texts.length > 0) {
    const elems = def.texts.flatMap(emitTextElementsForEntry);
    elements = `[${elems.join(", ")}]`;
  }
  const rev = def.revision ? emitStr(def.revision) : "None";
  return `lvd.TextList(${emitStr(def.name)}, ${elements}, ${rev})`;
}

function emitTextListForRemove(def: TextListRemoveDef): string {
  const elems = def.ids.map((id) => `lvd.TextElement(${emitStr(id)})`).join(", ");
  return `lvd.TextList(${emitStr(def.name)}, [${elems}], None)`;
}

function emitPropertySet(def: PropertySetDef): string {
  return `lvd.PropertySet(${emitStr(def.element)}, ${emitStr(def.property)}, ${emitPyScalar(def.value)})`;
}

function emitSchemeEntry(e: SchemeEntryDef): string {
  const prop = e.property ? emitStr(e.property) : "None";
  const val = emitPyScalar(e.value ?? null);
  const newPos = e.new_position !== undefined ? String(e.new_position) : "None";
  return `lvd.SchemeEntry(${e.position}, ${prop}, ${val}, ${newPos})`;
}

function emitSchemeFull(def: SchemeDef): string {
  const inp = def.input ? emitStr(def.input) : "None";
  let entries = "None";
  if (def.entries && def.entries.length > 0) {
    entries = `[${def.entries.map(emitSchemeEntry).join(", ")}]`;
  }
  return `lvd.Scheme(${emitStr(def.scheme_type)}, ${emitStr(def.name)}, ${inp}, ${entries})`;
}

function emitSchemeForRemove(def: { scheme_type: string; name: string }): string {
  return `lvd.Scheme(${emitStr(def.scheme_type)}, ${emitStr(def.name)}, None, None)`;
}

function emitSchemeForRemoveEntries(def: SchemeDef): string {
  const positions = def.positions ?? (def.entries?.map((e) => e.position) ?? []);
  const elems = positions.map((p) => `lvd.SchemeEntry(${p})`).join(", ");
  return `lvd.Scheme(${emitStr(def.scheme_type)}, ${emitStr(def.name)}, None, [${elems}])`;
}

function emitSchemeForMoves(def: SchemeDef): string {
  const moves = def.moves ?? [];
  const elems = moves.map((m) => `lvd.SchemeEntry(${m.from}, None, None, ${m.to})`).join(", ");
  return `lvd.Scheme(${emitStr(def.scheme_type)}, ${emitStr(def.name)}, None, [${elems}])`;
}

function emitSchemeForInput(def: SchemeDef): string {
  const inp = def.input ? emitStr(def.input) : "None";
  return `lvd.Scheme(${emitStr(def.scheme_type)}, ${emitStr(def.name)}, ${inp}, None)`;
}

function emitMediaItem(def: MediaItemDef): string {
  return `lvd.MediaItem(${emitStr(def.media_type)}, ${emitStr(def.path ?? def.name ?? "")})`;
}

// ── Script builder ────────────────────────────────────────────────────────────

export function buildVisuScript(
  lvpPath: string,
  ops: VisuOp[],
  saveAtEnd = true
): string {
  const lines: string[] = [
    "import sigmatek.lasal.lvd as lvd",
    "lvd.SetExceptionOnError(True)",
    `prj = lvd.LoadProject(${emitStr(lvpPath)})`,
    "if prj is None: raise RuntimeError(f'Failed to load project: {repr(" + emitStr(lvpPath) + ")}')",
    "",
  ];

  for (const op of ops) {
    switch (op.type) {

      case "update_all_stations":
        lines.push("lvd.UpdateAllStations(prj)");
        break;

      case "update_station":
        lines.push(`lvd.UpdateStation(prj, ${op.station_nr})`);
        break;

      case "publish":
        lines.push(`lvd.PublishProject(prj, ${op.debug ? "True" : "False"})`);
        break;

      case "add_text_lists":
        lines.push(
          `lvd.AddTextLists(prj, [${op.text_lists.map(emitTextList).join(", ")}])`
        );
        break;

      case "remove_text_lists":
        lines.push(`lvd.RemoveTextLists(prj, ${emitStrList(op.names)})`);
        break;

      case "add_texts":
        lines.push(
          `lvd.AddTexts(prj, [${op.text_lists.map(emitTextList).join(", ")}])`
        );
        break;

      case "remove_texts":
        lines.push(
          `lvd.RemoveTexts(prj, [${op.text_lists.map(emitTextListForRemove).join(", ")}])`
        );
        break;

      case "change_texts":
        lines.push(
          `lvd.ChangeTexts(prj, [${op.text_lists.map(emitTextList).join(", ")}])`
        );
        break;

      case "change_component_texts":
        lines.push(
          `lvd.ChangeComponentTexts(prj, [${op.text_lists.map(emitTextList).join(", ")}])`
        );
        break;

      case "set_text_list_revisions":
        lines.push(
          `lvd.SetTextListRevisions(prj, [${op.text_lists.map(emitTextList).join(", ")}])`
        );
        break;

      case "set_component_text_list_revisions":
        lines.push(
          `lvd.SetComponentTextListRevisions(prj, [${op.text_lists.map(emitTextList).join(", ")}])`
        );
        break;

      case "csv_export_text_lists":
        lines.push(
          `lvd.CsvExportTextLists(prj, ${emitStr(op.csv_path)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`
        );
        break;

      case "csv_import_text_lists":
        lines.push(
          `lvd.CsvImportTextLists(prj, ${emitStrList(op.file_paths)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`
        );
        break;

      case "csv_export_component_text_lists":
        lines.push(
          `lvd.CsvExportComponentTextLists(prj, ${emitStr(op.csv_path)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`
        );
        break;

      case "csv_import_component_text_lists":
        lines.push(
          `lvd.CsvImportComponentTextLists(prj, ${emitStrList(op.file_paths)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`
        );
        break;

      case "set_datapoint_properties":
        lines.push(
          `lvd.SetDatapointProperties(prj, [${op.properties.map(emitPropertySet).join(", ")}])`
        );
        break;

      case "set_datatype_properties":
        lines.push(
          `lvd.SetDataTypeProperties(prj, [${op.properties.map(emitPropertySet).join(", ")}])`
        );
        break;

      case "add_schemes":
        lines.push(
          `lvd.AddSchemes(prj, [${op.schemes.map(emitSchemeFull).join(", ")}])`
        );
        break;

      case "remove_schemes":
        lines.push(
          `lvd.RemoveSchemes(prj, [${op.schemes.map(emitSchemeForRemove).join(", ")}])`
        );
        break;

      case "add_scheme_entries":
        lines.push(
          `lvd.AddSchemeEntries(prj, [${op.schemes.map(emitSchemeFull).join(", ")}])`
        );
        break;

      case "remove_scheme_entries":
        lines.push(
          `lvd.RemoveSchemeEntries(prj, [${op.schemes.map(emitSchemeForRemoveEntries).join(", ")}])`
        );
        break;

      case "move_scheme_entries":
        lines.push(
          `lvd.MoveSchemeEntries(prj, [${op.schemes.map(emitSchemeForMoves).join(", ")}])`
        );
        break;

      case "set_scheme_inputs":
        lines.push(
          `lvd.SetSchemeInputs(prj, [${op.schemes.map(emitSchemeForInput).join(", ")}])`
        );
        break;

      case "set_scheme_properties":
        lines.push(
          `lvd.SetSchemeProperties(prj, ${emitStr(op.scheme_type)}, [${op.properties.map(emitPropertySet).join(", ")}])`
        );
        break;

      case "set_scheme_entry_properties":
        lines.push(
          `lvd.SetSchemeEntryProperties(prj, [${op.schemes.map(emitSchemeFull).join(", ")}])`
        );
        break;

      case "add_media_items": {
        const overwrite = op.overwrite ? "True" : "False";
        lines.push(
          `lvd.AddMediaItems(prj, [${op.items.map(emitMediaItem).join(", ")}], ${overwrite})`
        );
        break;
      }

      case "remove_media_items":
        lines.push(
          `lvd.RemoveMediaItems(prj, [${op.items.map(emitMediaItem).join(", ")}])`
        );
        break;

      case "add_code_modules":
        lines.push(`lvd.AddCodeModules(prj, ${emitStrList(op.paths)})`);
        break;

      case "remove_code_modules":
        lines.push(`lvd.RemoveCodeModules(prj, ${emitStrList(op.names)})`);
        break;

      case "update_property_values":
        lines.push("lvd.UpdatePropertyValues(prj)");
        break;

      case "download": {
        const flags = op.flags ?? 0;
        const addRuntime = op.add_runtime ? "True" : "False";
        lines.push(
          `lvd.DownloadProject(prj, ${emitStr(op.connection)}, ${flags}, ${addRuntime})`
        );
        break;
      }
    }
  }

  if (saveAtEnd) {
    lines.push("", "lvd.SaveProject(prj)");
  }
  lines.push("lvd.CloseProject(prj)");
  return lines.join("\n") + "\n";
}

// ── Script runner ─────────────────────────────────────────────────────────────

function ensureScratch() {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
}

function killVisuDesigner() {
  try { execSync(`taskkill /IM "VISUDesigner.exe" /F /T`, { stdio: "pipe" }); } catch { /* not running */ }
}

function parseLog(logPath: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.includes("(ERROR)") || t.includes("(FATAL)")) errors.push(t);
      else if (t.includes("(WARN)")) warnings.push(t);
    }
  }
  return { errors, warnings };
}

export function runVisuOps(
  lvpPath: string,
  ops: VisuOp[],
  saveAtEnd = true,
  timeoutMs = 180_000
): VisuResult {
  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `visu_${id}.py`);
  const logPath = join(SCRATCH, `visu_${id}.log`);

  writeFileSync(scriptPath, buildVisuScript(lvpPath, ops, saveAtEnd), "utf-8");

  const start = Date.now();
  let exitCode = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  killVisuDesigner();

  try {
    execFileSync(VISUDESIGNER_EXE, ["--script", scriptPath], {
      timeout: timeoutMs,
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (e: any) {
    exitCode = e.status ?? 1;
    // Capture Python traceback from stderr
    const stderr: string = (e.stderr ?? "").toString("utf-8").trim();
    if (stderr) {
      for (const line of stderr.split("\n")) {
        const t = line.trim();
        if (t) errors.push(t);
      }
    }
    try { execSync(`taskkill /IM "VISUDesigner.exe" /F /T`, { stdio: "pipe" }); } catch { /* ignore */ }
  }

  const durationMs = Date.now() - start;

  // Also parse any log file VISUDesigner may have written
  const { errors: logErrors, warnings: logWarnings } = parseLog(logPath);
  errors.push(...logErrors);
  warnings.push(...logWarnings);

  if (exitCode !== 0 && errors.length === 0) {
    errors.push(`VISUDesigner.exe exited with code ${exitCode}`);
  }

  return { ok: exitCode === 0 && errors.length === 0, exitCode, logPath, errors, warnings, durationMs };
}
