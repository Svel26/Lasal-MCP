import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { VISUDESIGNER_EXE, SCRATCH, killVisuDesigner } from "./engine.js";
import { runEngineScript, type StepOutcome } from "./scriptRunner.js";
import { ensureScratch } from "../core/scratch.js";

export interface VisuResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
  errors: string[];
  warnings: string[];
  durationMs: number;
  steps?: StepOutcome[];
  timedOut?: boolean;
  hints?: string[];
}

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

function emitTextElementsForEntry(entry: TextEntry): string[] {
  const { id, ...langs } = entry;
  const langKeys = Object.keys(langs).filter((k) => langs[k] !== undefined);
  if (langKeys.length === 0) {
    return [`lvd.TextElement(${emitStr(id!)})`];
  }
  return langKeys.map((lang) => `lvd.TextElement(${emitStr(id!)}, ${emitStr(lang)}, ${emitStr(langs[lang]!)})`);
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

// Positions or entries to remove
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

export function buildVisuScript(
  lvpPath: string,
  ops: VisuOp[],
  logPath: string,
  stepsPath: string,
  saveAtEnd = true
): { script: string; expectedSteps: string[] } {
  const lines: string[] = [];
  const expectedSteps: string[] = ["LoadProject"];

  const pyStepsPath = stepsPath.replace(/\\/g, "\\\\");

  lines.push(
    "    f_step = open(r\"" + stepsPath + "\", \"a\", encoding=\"utf-8\")",
    "    f_step.write(\"STEP LoadProject OK\\n\")",
    "    f_step.close()",
    ""
  );

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op) continue;
    const label = `${i}_${op.type}`;
    expectedSteps.push(label);

    const opLines: string[] = [];
    switch (op.type) {
      case "update_all_stations":
        opLines.push("lvd.UpdateAllStations(prj)");
        break;
      case "update_station":
        opLines.push(`lvd.UpdateStation(prj, ${op.station_nr})`);
        break;
      case "publish":
        opLines.push(`lvd.PublishProject(prj, ${op.debug ? "True" : "False"})`);
        break;
      case "add_text_lists":
        opLines.push(`lvd.AddTextLists(prj, [${op.text_lists.map(emitTextList).join(", ")}])`);
        break;
      case "remove_text_lists":
        opLines.push(`lvd.RemoveTextLists(prj, ${emitStrList(op.names)})`);
        break;
      case "add_texts":
        opLines.push(`lvd.AddTexts(prj, [${op.text_lists.map(emitTextList).join(", ")}])`);
        break;
      case "remove_texts":
        opLines.push(`lvd.RemoveTexts(prj, [${op.text_lists.map(emitTextListForRemove).join(", ")}])`);
        break;
      case "change_texts":
        opLines.push(`lvd.ChangeTexts(prj, [${op.text_lists.map(emitTextList).join(", ")}])`);
        break;
      case "change_component_texts":
        opLines.push(`lvd.ChangeComponentTexts(prj, [${op.text_lists.map(emitTextList).join(", ")}])`);
        break;
      case "set_text_list_revisions":
        opLines.push(`lvd.SetTextListRevisions(prj, [${op.text_lists.map(emitTextList).join(", ")}])`);
        break;
      case "set_component_text_list_revisions":
        opLines.push(`lvd.SetComponentTextListRevisions(prj, [${op.text_lists.map(emitTextList).join(", ")}])`);
        break;
      case "csv_export_text_lists":
        opLines.push(`lvd.CsvExportTextLists(prj, ${emitStr(op.csv_path)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`);
        break;
      case "csv_import_text_lists":
        opLines.push(`lvd.CsvImportTextLists(prj, ${emitStrList(op.file_paths)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`);
        break;
      case "csv_export_component_text_lists":
        opLines.push(`lvd.CsvExportComponentTextLists(prj, ${emitStr(op.csv_path)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`);
        break;
      case "csv_import_component_text_lists":
        opLines.push(`lvd.CsvImportComponentTextLists(prj, ${emitStrList(op.file_paths)}, ${emitOptStrList(op.text_lists)}, ${emitOptStrList(op.languages)})`);
        break;
      case "set_datapoint_properties":
        opLines.push(`lvd.SetDatapointProperties(prj, [${op.properties.map(emitPropertySet).join(", ")}])`);
        break;
      case "set_datatype_properties":
        opLines.push(`lvd.SetDataTypeProperties(prj, [${op.properties.map(emitPropertySet).join(", ")}])`);
        break;
      case "add_schemes":
        opLines.push(`lvd.AddSchemes(prj, [${op.schemes.map(emitSchemeFull).join(", ")}])`);
        break;
      case "remove_schemes":
        opLines.push(`lvd.RemoveSchemes(prj, [${op.schemes.map(emitSchemeForRemove).join(", ")}])`);
        break;
      case "add_scheme_entries":
        opLines.push(`lvd.AddSchemeEntries(prj, [${op.schemes.map(emitSchemeFull).join(", ")}])`);
        break;
      case "remove_scheme_entries":
        opLines.push(`lvd.RemoveSchemeEntries(prj, [${op.schemes.map(emitSchemeForRemoveEntries).join(", ")}])`);
        break;
      case "move_scheme_entries":
        opLines.push(`lvd.MoveSchemeEntries(prj, [${op.schemes.map(emitSchemeForMoves).join(", ")}])`);
        break;
      case "set_scheme_inputs":
        opLines.push(`lvd.SetSchemeInputs(prj, [${op.schemes.map(emitSchemeForInput).join(", ")}])`);
        break;
      case "set_scheme_properties":
        opLines.push(`lvd.SetSchemeProperties(prj, ${emitStr(op.scheme_type)}, [${op.properties.map(emitPropertySet).join(", ")}])`);
        break;
      case "set_scheme_entry_properties":
        opLines.push(`lvd.SetSchemeEntryProperties(prj, [${op.schemes.map(emitSchemeFull).join(", ")}])`);
        break;
      case "add_media_items": {
        const overwrite = op.overwrite ? "True" : "False";
        opLines.push(`lvd.AddMediaItems(prj, [${op.items.map(emitMediaItem).join(", ")}], ${overwrite})`);
        break;
      }
      case "remove_media_items":
        opLines.push(`lvd.RemoveMediaItems(prj, [${op.items.map(emitMediaItem).join(", ")}])`);
        break;
      case "add_code_modules":
        opLines.push(`lvd.AddCodeModules(prj, ${emitStrList(op.paths)})`);
        break;
      case "remove_code_modules":
        opLines.push(`lvd.RemoveCodeModules(prj, ${emitStrList(op.names)})`);
        break;
      case "update_property_values":
        opLines.push("lvd.UpdatePropertyValues(prj)");
        break;
      case "download": {
        const flags = op.flags ?? 0;
        const addRuntime = op.add_runtime ? "True" : "False";
        opLines.push(`lvd.DownloadProject(prj, ${emitStr(op.connection)}, ${flags}, ${addRuntime})`);
        break;
      }
    }

    for (const opLine of opLines) {
      lines.push(`    ${opLine}`);
    }

    lines.push(
      `    f_step = open(r"${stepsPath}", "a", encoding="utf-8")`,
      `    f_step.write("STEP ${label} OK\\n")`,
      `    f_step.close()`,
      ""
    );
  }

  if (saveAtEnd) {
    expectedSteps.push("SaveProject");
    lines.push(
      "    lvd.SaveProject(prj)",
      `    f_step = open(r"${stepsPath}", "a", encoding="utf-8")`,
      `    f_step.write("STEP SaveProject OK\\n")`,
      `    f_step.close()`,
      ""
    );
  }

  expectedSteps.push("CloseProject");
  lines.push(
    "    lvd.CloseProject(prj)",
    `    f_step = open(r"${stepsPath}", "a", encoding="utf-8")`,
    `    f_step.write("STEP CloseProject OK\\n")`,
    `    f_step.close()`,
    ""
  );

  const indentedBody = lines.map(line => line ? `    ${line}` : "").join("\n");

  const finalScript = [
    "import sys",
    "import traceback",
    `log_file = open(${emitStr(logPath)}, "w", encoding="utf-8")`,
    "sys.stdout = log_file",
    "sys.stderr = log_file",
    "",
    "import sigmatek.lasal.lvd as lvd",
    "lvd.SetExceptionOnError(True)",
    "",
    "try:",
    `    prj = lvd.LoadProject(${emitStr(lvpPath)})`,
    "    if prj is None: raise RuntimeError('Failed to load project')",
    "",
    lines.join("\n"),
    "except Exception as e:",
    "    print('(ERROR) Exception occurred during script execution:')",
    "    traceback.print_exc()",
    "    sys.exit(1)",
    "finally:",
    "    log_file.close()"
  ].join("\n") + "\n";

  return {
    script: finalScript,
    expectedSteps
  };
}

export async function runVisuOps(
  lvpPath: string,
  ops: VisuOp[],
  saveAtEnd = true,
  timeoutMs = 180_000,
): Promise<VisuResult> {
  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `visu_${id}.py`);
  const logPath = join(SCRATCH, `visu_${id}.log`);
  const stepsPath = join(SCRATCH, `visu_${id}.steps`);

  const { script, expectedSteps } = buildVisuScript(lvpPath, ops, logPath, stepsPath, saveAtEnd);
  writeFileSync(scriptPath, script, "utf-8");

  killVisuDesigner();

  const result = await runEngineScript(
    scriptPath,
    {
      exe: VISUDESIGNER_EXE,
      argsFor: (p) => ["--script", p],
      timeoutMs,
      logEncoding: "utf-8",
      killOnFailure: killVisuDesigner,
      expectedSteps,
      stepsPath,
    },
    logPath,
  );

  return {
    ok: result.ok,
    exitCode: result.exitCode,
    logPath: result.logPath,
    errors: result.errors,
    warnings: result.warnings,
    durationMs: result.durationMs,
    steps: result.steps,
    timedOut: result.timedOut,
    hints: result.hints,
  };
}
