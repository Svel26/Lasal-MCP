import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { SCRATCH, killLasalScreen, lsePowerShellPath, getLseRegistration } from "./engine.js";
import { runEngineScript, type StepOutcome } from "./scriptRunner.js";
import { ensureScratch } from "../core/scratch.js";

// ─── LASAL Screen (LSE) automation ────────────────────────────────────────────
//
// The LSE editor (LSE_modeless.exe) hosts an out-of-process COM automation
// server (`LASALScreen.Application`, type library `LASALScreen 2.0`). The
// server is registered as a 32-bit LocalServer32, so the driver runs inside a
// Windows PowerShell host of the matching bitness. Scripts are generated to the
// scratch dir, executed headlessly, and report their findings through a JSON
// result file plus a log (same STEP protocol as the other engines).

export interface LseButtonUpdate {
  /** LSButtonProperty constant (name or number): Doubleclick|Theme|ColorBackground|ColorFill|ColorText|ColorTopLeft|ColorBottomRight|Zoom */
  property: string | number;
  value: string | number | boolean;
  /** Invert the theme imagining (LSBP only where supported). */
  inverse?: boolean;
}

export interface LseSettingsSet {
  screen_width?: number;
  screen_height?: number;
  target_width?: number;
  target_height?: number;
  compiler_warnings?: boolean;
  compiler_version?: number;
  online_ip?: string;
  online_connection?: string;
}

export type LseOp =
  | { type: "info" }
  | { type: "compile" }
  | { type: "download"; run?: boolean; connection?: string }
  | {
      type: "export_xml";
      path: string;
      overwrite?: boolean;
      /** LCIDs to add to the compilation language list before exporting. */
      languages?: number[];
      /** Also capture container size + font scheme info for placed texts. */
      container_info?: boolean;
      /** Use the sorted text-list array in the XML output. */
      sorted_array?: boolean;
    }
  | { type: "import_xml"; path: string }
  | { type: "export"; path: string; settings_file?: string; overwrite?: boolean }
  | {
      type: "merge";
      file: string;
      overwrite?: boolean;
      deep_merge?: boolean;
      skip_global_screen?: boolean;
      screen_x_offset?: number;
      screen_y_offset?: number;
      softkey_offset?: number;
      softkey_valid?: boolean;
    }
  | { type: "fuse"; file: string; critical_changes?: boolean }
  | { type: "import_variables"; file: string; station_number: number }
  | { type: "import_scl"; name: string }
  | { type: "textlist_import_file"; file: string; language_id?: number }
  | { type: "textlist_import"; text_list: string; file: string; language_id?: number }
  | { type: "textlist_create"; name: string; text?: string }
  | { type: "textlist_add_text"; text_list: string; text?: string }
  | { type: "textlist_set_text"; text_list: string; item: string | number; language_id: number; text: string }
  | { type: "textlist_get_texts"; text_list: string; languages?: number[] }
  | { type: "add_language"; language_id: number }
  | { type: "clear_languages" }
  | { type: "set_actual_language"; language_id: number }
  | { type: "update_buttons"; updates: LseButtonUpdate[] }
  | { type: "update_softkeys"; updates: LseButtonUpdate[] }
  | { type: "settings_set"; settings: LseSettingsSet }
  | { type: "image_insert"; file: string; transparent_rgb?: number };

export interface LseResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  steps: StepOutcome[];
  errors: string[];
  warnings: string[];
  logTail: string[];
  logPath: string;
  durationMs: number;
  hints: string[];
  data?: Record<string, unknown>;
}

export const LSE_BUTTON_PROPERTIES: Record<string, number> = {
  doubleclick: 1,
  theme: 2,
  colorbackground: 3,
  colorfill: 4,
  colortext: 5,
  colortopleft: 6,
  colorbottomright: 7,
  zoom: 8,
};

export const LSE_SOFTKEY_PROPERTIES: Record<string, number> = {
  theme: 2,
};

export function resolveLseButtonProperty(property: string | number, table: Record<string, number>): number {
  if (typeof property === "number") return property;
  const n = table[property.toLowerCase()];
  if (n === undefined) {
    const names = Object.keys(table).join(", ");
    throw new Error(`Unknown property '${property}'. Available: ${names} (or pass the numeric constant).`);
  }
  return n;
}

// ─── PowerShell emission helpers ──────────────────────────────────────────────

function psStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function psValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "$true" : "$false";
  if (typeof v === "number") return String(v);
  return psStr(v);
}

function psPath(p: string): string {
  return psStr(p);
}

function tryLine(tsLines: string[], psBody: string, warnLabel: string): void {
  tsLines.push(
    `try { ${psBody} } catch { Add-Content -LiteralPath $logPath -Value ("(WARN) ${warnLabel}: " + $_.Exception.Message) }`,
  );
}

// ─── Script builder ───────────────────────────────────────────────────────────

export interface BuildLseScriptOptions {
  logPath: string;
  stepsPath: string;
  resultPath: string;
  saveAtEnd: boolean;
}

export function buildLseScript(
  lprPath: string,
  ops: LseOp[],
  opts: BuildLseScriptOptions,
): { script: string; expectedSteps: string[] } {
  const { logPath, stepsPath, resultPath } = opts;
  const body: string[] = [];
  const expectedSteps: string[] = ["CreateApp", "LoadProject"];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op) continue;
    const label = `${i}_${op.type}`;
    expectedSteps.push(label);
    const lines: string[] = [];

    switch (op.type) {
      case "info": {
        lines.push(
          "$screens = $prj.Screens",
          "$arr = @(); $n = Get-Count $screens; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $screens $i; if ($o) { $nm = Get-ObjName $o; if ($nm) { $arr += $nm } } }; $results['screens'] = $arr",
          "$arr = @(); $n = Get-Count $prj.Windows; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $prj.Windows $i; if ($o) { $nm = Get-ObjName $o; if ($nm) { $arr += $nm } } }; $results['windows'] = $arr",
          "$arr = @(); $n = Get-Count $prj.Alarms; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $prj.Alarms $i; if ($o) { $nm = Get-ObjName $o; if ($nm) { $arr += $nm } } }; $results['alarms'] = $arr",
          "$arr = @(); $n = Get-Count $prj.Servers; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $prj.Servers $i; if ($o) { $nm = Get-ObjName $o; if ($nm) { $arr += $nm } } }; $results['servers'] = $arr",
          "$arr = @(); $n = Get-Count $prj.Images; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $prj.Images $i; if ($o) { $nm = Get-ObjName $o; if ($nm) { $arr += $nm } } }; $results['images'] = $arr",
          "$arr = @(); $n = Get-Count $prj.Languages; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $prj.Languages $i; if ($o) { $arr += @{ name = (Get-ObjName $o); id = (Get-ObjLangId $o) } } }; $results['languages'] = $arr",
          "$arr = @(); $tl = $prj.TextLists; $n = Get-Count $tl; for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $tl $i; if ($o) { $arr += @{ name = (Get-ObjName $o); itemCount = (Get-Count $o) } } }; $results['textLists'] = $arr",
          "$results['counts'] = @{ servers = (Get-Count $prj.Servers); images = (Get-Count $prj.Images); alarms = (Get-Count $prj.Alarms); themes = (Get-Count $prj.Themes); colors = (Get-Count $prj.Colors); objects = (Get-Count $prj.Objects) }",
          "try { $gs = $prj.GlobalScreen; $results['globalScreen'] = (Get-ObjName $gs) } catch { }",
          "$st = $prj.Settings",
          "try { $sr = $st.ScreenResolution; $results['screenResolution'] = @{ width = [int]$sr.Width; height = [int]$sr.Height } } catch { }",
          "try { $tr = $st.TargetResolution; $results['targetResolution'] = @{ width = [int]$tr.Width; height = [int]$tr.Height } } catch { }",
          "try { $results['compilerVersion'] = [int]$st.CompilerVersion } catch { }",
          "try { $results['compilerWarnings'] = [bool]$st.CompilerWarnings } catch { }",
          "try { $results['softkeyCount'] = [int]$st.SoftkeyCount } catch { }",
          "try { $results['actualLanguage'] = [int]$prj.ActualLanguage($false) } catch { }",
        );
        break;
      }
      case "compile": {
        lines.push(
          "$r = $prj.Compile()",
          `Add-Content -LiteralPath $logPath -Value ("(INFO) Compile returned: " + "$r")`,
        );
        break;
      }
      case "download": {
        if (op.connection) {
          const ipOnly = op.connection.replace(/^TCPIP:/i, "").split(":")[0];
          tryLine(
            lines,
            `$st = $prj.Settings; $st.OnlineIPAddress = ${psStr(ipOnly ?? op.connection)}`,
            "OnlineIPAddress override",
          );
        }
        lines.push(
          "$r = $prj.DownloadProject(" + (op.run === false ? "$false" : "$true") + ")",
          `Add-Content -LiteralPath $logPath -Value ("(INFO) DownloadProject returned: " + "$r")`,
          `if ("$r" -eq "False") { throw 'DownloadProject reported failure (returned False)' }`,
        );
        break;
      }
      case "export_xml": {
        if (op.languages && op.languages.length > 0) {
          for (const lang of op.languages) {
            tryLine(lines, `[void]$prj.AddCompilationLanguage(${lang})`, `AddCompilationLanguage(${lang})`);
          }
        }
        if (op.container_info !== undefined) {
          tryLine(lines, `[void]$prj.AddContainerInfo(${op.container_info ? "$true" : "$false"})`, "AddContainerInfo");
        }
        if (op.sorted_array !== undefined) {
          tryLine(lines, `[void]$prj.UseSortedArray(${op.sorted_array ? "$true" : "$false"})`, "UseSortedArray");
        }
        lines.push(
          `Remove-Item -LiteralPath ${psPath(op.path)} -ErrorAction SilentlyContinue`,
          `$r = $prj.ExportToXML(${psPath(op.path)}, ${op.overwrite === false ? "$false" : "$true"})`,
          `if (-not (Test-Path -LiteralPath ${psPath(op.path)})) { throw 'ExportToXML produced no file (LASAL Screen may require an XML export language/text-list selection that the automation interface does not expose).' }`,
        );
        break;
      }
      case "import_xml": {
        lines.push(
          `$r = $prj.ImportFromXML(${psPath(op.path)})`,
          `Add-Content -LiteralPath $logPath -Value ("(INFO) ImportFromXML returned: " + "$r")`,
        );
        break;
      }
      case "export": {
        lines.push(
          `try { $r = $prj.Export(${op.settings_file ? psPath(op.settings_file) : "''"}, ${psPath(op.path)}, ${op.overwrite === true ? "$true" : "$false"}); $results['export'] = "$r" }`,
          `catch { Add-Content -LiteralPath $logPath -Value ("(WARN) Project.Export failed, trying Application.ExportTo: " + $_.Exception.Message); $app.ExportTo(${psPath(op.path)}, ${op.overwrite === true ? "$true" : "$false"}) }`,
        );
        break;
      }
      case "merge": {
        const mpLines: Array<[string, string]> = [];
        if (op.overwrite !== undefined) mpLines.push(["Overwrite", op.overwrite ? "$true" : "$false"]);
        if (op.deep_merge !== undefined) mpLines.push(["DeepMerge", op.deep_merge ? "$true" : "$false"]);
        if (op.skip_global_screen !== undefined)
          mpLines.push(["SkipGlobalScreen", op.skip_global_screen ? "$true" : "$false"]);
        if (op.screen_x_offset !== undefined) mpLines.push(["ScreenXOffset", String(op.screen_x_offset)]);
        if (op.screen_y_offset !== undefined) mpLines.push(["ScreenYOffset", String(op.screen_y_offset)]);
        if (op.softkey_offset !== undefined) mpLines.push(["SoftkeyOffset", String(op.softkey_offset)]);
        if (op.softkey_valid !== undefined) mpLines.push(["SoftkeyValid", op.softkey_valid ? "$true" : "$false"]);
        lines.push("$mp = $prj.MergeParameter");
        for (const [prop, val] of mpLines) {
          tryLine(lines, `$mp.${prop} = ${val}`, `MergeParameter.${prop}`);
        }
        lines.push(
          "$usedEx = $false",
          `try { $r = $prj.MergeEx(${psPath(op.file)}); $results['merge'] = "$r"; $usedEx = $true } catch { Add-Content -LiteralPath $logPath -Value ("(WARN) MergeEx failed, falling back to Merge: " + $_.Exception.Message) }`,
          `if (-not $usedEx) { $r = $prj.Merge(${psPath(op.file)}, ${op.overwrite === false ? "$false" : "$true"}); $results['merge'] = "$r" }`,
        );
        break;
      }
      case "fuse": {
        lines.push(
          `$r = $prj.Fuse(${psPath(op.file)}, ${op.critical_changes === false ? "$false" : "$true"})`,
          `$results['fuse'] = "$r"`,
        );
        break;
      }
      case "import_variables": {
        lines.push(
          `$r = $prj.ImportVariables(${psPath(op.file)}, ${op.station_number})`,
          `$results['import_variables'] = "$r"`,
        );
        break;
      }
      case "import_scl": {
        lines.push(`$r = $prj.ImportSCL(${psStr(op.name)})`, `$results['import_scl'] = "$r"`);
        break;
      }
      case "textlist_import_file": {
        lines.push(
          op.language_id !== undefined
            ? `$r = $prj.ImportTextFile(${psPath(op.file)}, ${op.language_id})`
            : `$r = $prj.ImportTextFile(${psPath(op.file)})`,
          `$results['textlist_import_file'] = "$r"`,
        );
        break;
      }
      case "textlist_import": {
        lines.push(
          op.language_id !== undefined
            ? `$r = $prj.ImportTextList(${psStr(op.text_list)}, ${psPath(op.file)}, ${op.language_id})`
            : `$r = $prj.ImportTextList(${psStr(op.text_list)}, ${psPath(op.file)})`,
          `$results['textlist_import'] = "$r"`,
        );
        break;
      }
      case "textlist_create": {
        lines.push(
          `$r = $prj.TextLists.Insert(${psStr(op.name)}, ${op.text !== undefined ? psStr(op.text) : "''"})`,
          `$results['textlist_create'] = "$r"`,
        );
        break;
      }
      case "textlist_add_text": {
        lines.push(
          `$tl = Get-ItemByRef $prj.TextLists ${psStr(op.text_list)}`,
          `if ($null -eq $tl) { throw 'Textlist not found: ${op.text_list.replace(/'/g, "''")}' }`,
          `$r = $tl.Insert(${op.text !== undefined ? psStr(op.text) : "''"})`,
          `$results['textlist_add_text'] = "$r"`,
        );
        break;
      }
      case "textlist_set_text": {
        const itemLit = typeof op.item === "number" ? String(op.item) : psStr(op.item);
        lines.push(
          `$tl = Get-ItemByRef $prj.TextLists ${psStr(op.text_list)}`,
          `if ($null -eq $tl) { throw 'Textlist not found: ${op.text_list.replace(/'/g, "''")}' }`,
          "$it = $null",
          `try { $it = $tl.Item(${itemLit}) } catch { }`,
          `if ($null -eq $it) { try { $it = $tl.Item(${itemLit}, $false) } catch { } }`,
          `if ($null -eq $it) { throw 'Text item not found in ${op.text_list.replace(/'/g, "''")}: ${String(op.item).replace(/'/g, "''")}' }`,
          `$it.Text(${op.language_id}) = ${psStr(op.text)}`,
          `try { $chk = $it.Text(${op.language_id}); $results['textlist_set_text'] = "$chk" } catch { }`,
        );
        break;
      }
      case "textlist_get_texts": {
        const langsJson = JSON.stringify(op.languages ?? []);
        lines.push(
          `$tl = Get-ItemByRef $prj.TextLists ${psStr(op.text_list)}`,
          `if ($null -eq $tl) { throw 'Textlist not found: ${op.text_list.replace(/'/g, "''")}' }`,
          `$langIds = @(${langsJson.replace(/^\[|\]$/g, "")})`,
          "if ($langIds.Count -eq 0) { $ln = Get-Count $prj.Languages; for ($i = 0; $i -lt $ln; $i++) { $lo = Get-ItemAt $prj.Languages $i; if ($lo) { $lid = Get-ObjLangId $lo; if ($lid -ge 0) { $langIds += $lid } } } }",
          "$items = @()",
          "$n = Get-Count $tl",
          'for ($i = 0; $i -lt $n; $i++) { $o = Get-ItemAt $tl $i; if ($o) { $rec = @{}; foreach ($lid in $langIds) { try { $rec["$lid"] = "$($o.Text($lid))"; } catch { } }; $items += $rec } }',
          "$results['textItems'] = $items",
        );
        break;
      }
      case "add_language": {
        lines.push(`$r = $prj.AddCompilationLanguage(${op.language_id})`, `$results['add_language'] = "$r"`);
        break;
      }
      case "clear_languages": {
        lines.push(`$r = $prj.ClearCompilationLanguages()`, `$results['clear_languages'] = "$r"`);
        break;
      }
      case "set_actual_language": {
        lines.push(`$prj.ActualLanguage = ${op.language_id}`, `$results['actualLanguage'] = ${op.language_id}`);
        break;
      }
      case "update_buttons": {
        for (const u of op.updates) {
          const propIdx = resolveLseButtonProperty(u.property, LSE_BUTTON_PROPERTIES);
          lines.push(
            `$r = $prj.UpdateButtons(${propIdx}, ${psValue(u.value)}, ${u.inverse ? "$true" : "$false"})`,
            `$results['update_buttons_${propIdx}'] = "$r"`,
          );
        }
        break;
      }
      case "update_softkeys": {
        for (const u of op.updates) {
          const propIdx = resolveLseButtonProperty(u.property, LSE_SOFTKEY_PROPERTIES);
          lines.push(
            `$r = $prj.UpdateSoftkeys(${propIdx}, ${psValue(u.value)}, ${u.inverse ? "$true" : "$false"})`,
            `$results['update_softkeys_${propIdx}'] = "$r"`,
          );
        }
        break;
      }
      case "settings_set": {
        const s = op.settings;
        if (s.screen_width !== undefined && s.screen_height !== undefined) {
          tryLine(
            lines,
            `$st = $prj.Settings; $st.SetScreenResolution(${s.screen_width}, ${s.screen_height})`,
            "SetScreenResolution",
          );
        }
        if (s.target_width !== undefined && s.target_height !== undefined) {
          tryLine(
            lines,
            `$st = $prj.Settings; $st.SetTargetResolution(${s.target_width}, ${s.target_height})`,
            "SetTargetResolution",
          );
        }
        if (s.compiler_warnings !== undefined) {
          tryLine(
            lines,
            `$st = $prj.Settings; $st.SetCompilerWarnings(${s.compiler_warnings ? "$true" : "$false"})`,
            "SetCompilerWarnings",
          );
        }
        if (s.compiler_version !== undefined) {
          tryLine(lines, `$st = $prj.Settings; $st.CompilerVersion = ${s.compiler_version}`, "CompilerVersion");
        }
        if (s.online_ip !== undefined) {
          tryLine(lines, `$st = $prj.Settings; $st.OnlineIPAddress = ${psStr(s.online_ip)}`, "OnlineIPAddress");
        }
        if (s.online_connection !== undefined) {
          tryLine(
            lines,
            `$st = $prj.Settings; $st.OnlineConnection = ${psStr(s.online_connection)}`,
            "OnlineConnection",
          );
        }
        lines.push(`$results['settings_set'] = 'ok'`);
        break;
      }
      case "image_insert": {
        lines.push(
          `try { $r = $prj.Images.Insert(${psPath(op.file)}) } catch { $r = $prj.Images.Insert(${psPath(op.file)}, ${op.transparent_rgb !== undefined ? op.transparent_rgb : -1}) }`,
          `$results['image_insert'] = "$r"`,
        );
        break;
      }
    }

    body.push(...lines.map((l) => `  ${l}`));
    body.push(`  Write-Step '${label}'`);
    body.push("");
  }

  if (opts.saveAtEnd) {
    expectedSteps.push("SaveProject");
    body.push("  $r = $prj.Save()", "  Write-Step 'SaveProject'", "");
  }

  expectedSteps.push("CloseProject");
  body.push("  $prj.Close($false)", "  Write-Step 'CloseProject'", "");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$logPath = ${psStr(logPath)}`,
    "",
    "function Write-Step([string]$label) { Add-Content -LiteralPath " +
      psStr(stepsPath) +
      " -Value ('STEP ' + $label + ' OK') -Encoding UTF8 }",
    "function Get-Count($coll) {",
    "  try { $c = $coll.Count(); if ($null -ne $c) { return [int]$c } } catch { }",
    "  try { return [int]$coll.Count } catch { }",
    "  return -1",
    "}",
    "function Get-ItemAt($coll, $idx) {",
    "  try { return $coll.Item($idx, $true) } catch { }",
    "  try { return $coll.Item($idx) } catch { }",
    "  return $null",
    "}",
    "function Get-ItemByRef($coll, $ref) {",
    "  try { return $coll.Item($ref) } catch { }",
    "  try { return $coll.Item($ref, $true) } catch { }",
    "  return $null",
    "}",
    "function Get-ObjName($obj) {",
    '  try { $n = $obj.Name(); if ($null -ne $n -and "$n" -ne \'\') { return "$n" } } catch { }',
    '  try { $n2 = $obj.Name; if ($null -ne $n2 -and "$n2" -ne \'\') { return "$n2" } } catch { }',
    "  return $null",
    "}",
    "function Get-ObjLangId($obj) {",
    "  try { $n = $obj.LanguageID(); if ($null -ne $n) { return [int]$n } } catch { }",
    "  try { return [int]$obj.LanguageID } catch { }",
    "  return -1",
    "}",
    `$resultPath = ${psStr(resultPath)}`,
    "$failed = $false",
    "$results = @{}",
    "$app = $null",
    "try {",
    "  $app = New-Object -ComObject LASALScreen.Application",
    "  Write-Step 'CreateApp'",
    `  $prj = $app.Open(${psPath(lprPath)})`,
    "  if ($null -eq $prj) { throw 'LASALScreen.Application.Open returned no project' }",
    "  Write-Step 'LoadProject'",
    body.join("\n"),
    "  $results['ok'] = $true",
    "} catch {",
    "  $failed = $true",
    "  $results['ok'] = $false",
    "  $results['error'] = $_.Exception.Message",
    "  Add-Content -LiteralPath $logPath -Value ('(ERROR) ' + $_.Exception.Message) -Encoding UTF8",
    "} finally {",
    "  try { $results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8 } catch { }",
    "  if ($null -ne $app) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { } }",
    "}",
    "if ($failed) { exit 1 }",
    "exit 0",
  ].join("\n");

  return { script: script + "\n", expectedSteps };
}

// ─── Hints ────────────────────────────────────────────────────────────────────

const LSE_HINT_TABLE = [
  {
    pattern: /not registered|Cannot load COM type|Retrieving the COM class factory|Class not registered|80040154/i,
    hint:
      "The LASAL Screen automation server (LASALScreen.Application) is not registered. Open LASAL Screen once and use its registration dialog " +
      "(or rerun the LSE installer) to register the automation components, then retry.",
  },
  {
    pattern: /No language selected/i,
    hint:
      "LASAL Screen requires an XML export language/text-list selection that its automation interface (through LSE 01.01.197) does not expose. " +
      "Export once from the editor (Text > XML Texts > Export), or use the granular text-list operations (textlist_set_text, textlist_import_file) instead.",
  },
  {
    pattern: /Online connection name can not be found/i,
    hint: "The online connection name is not in the LASAL address book. Use online_ip instead, or pick an existing connection name.",
  },
  {
    pattern: /No project opened|Cannot load project|Failed to load/i,
    hint: "The .lpr project could not be loaded. Verify the path and that the project is saved in a compatible LSE version.",
  },
  {
    pattern: /read-only|readonly|sharing violation|denied/i,
    hint: "The project is read-only or locked. Close other LSE windows and check file permissions.",
  },
  {
    pattern: /timed out/i,
    hint: "LSE automation timed out — large projects can take a while. Raise timeout_s or LASAL_MCP_TIMEOUT_LSE, and prefer one project per call.",
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface RunLseOptions {
  saveAtEnd?: boolean;
  timeoutMs?: number;
}

export async function runLseOps(lprPath: string, ops: LseOp[], options: RunLseOptions = {}): Promise<LseResult> {
  const saveAtEnd = options.saveAtEnd ?? false;
  const timeoutMs = options.timeoutMs ?? 300_000;

  const registration = getLseRegistration();
  if (!registration.registered) {
    return {
      ok: false,
      exitCode: -1,
      timedOut: false,
      steps: [],
      errors: [
        `The LASAL Screen automation server (${LSE_PROGID_HINT}) is not registered on this machine (CLSID LocalServer32 not found in HKLM 32/64-bit views).`,
      ],
      warnings: [],
      logTail: [],
      logPath: "",
      durationMs: 0,
      hints: [LSE_HINT_TABLE[0]!.hint],
    };
  }

  ensureScratch();
  const id = randomUUID();
  const scriptPath = join(SCRATCH, `lse_${id}.ps1`);
  const logPath = join(SCRATCH, `lse_${id}.log`);
  const stepsPath = join(SCRATCH, `lse_${id}.steps`);
  const resultPath = join(SCRATCH, `lse_${id}.result.json`);

  const { script, expectedSteps } = buildLseScript(lprPath, ops, { logPath, stepsPath, resultPath, saveAtEnd });
  // BOM so Windows PowerShell 5.1 parses non-ASCII paths correctly.
  writeFileSync(scriptPath, `\uFEFF${script}`, "utf-8");

  killLasalScreen();

  const run = await runEngineScript(
    scriptPath,
    {
      exe: lsePowerShellPath(),
      argsFor: (p) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p],
      timeoutMs,
      logEncoding: "utf-8",
      killOnFailure: killLasalScreen,
      expectedSteps,
      stepsPath,
    },
    logPath,
  );

  // Always tear the automation host down: it locks the .lpr/.lsn files while open.
  killLasalScreen();

  let data: Record<string, unknown> | undefined;
  try {
    const raw = readFileSync(resultPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    data = parsed;

    // Prefer the script's own error report over generic runner noise.
    if (parsed.ok === false && typeof parsed.error === "string" && parsed.error) {
      run.errors.unshift(parsed.error);
    }
    // Drop the generic "not all steps completed" message when we have a concrete error.
    if (parsed.ok === false && typeof parsed.error === "string" && parsed.error) {
      const concrete = parsed.error;
      run.errors = run.errors.filter(
        (e) => !/^Engine exited but not all expected operations completed/i.test(e) || e.includes(concrete),
      );
    }
  } catch {
    /* no result file */
  }

  const hints = [...run.hints];
  const hasFailed = !run.ok || run.errors.length > 0 || run.timedOut;
  if (hasFailed) {
    const haystack = [...run.errors, ...run.warnings, ...(data ? [String(data.error ?? "")] : [])];
    for (const mapping of LSE_HINT_TABLE) {
      if (haystack.some((line) => mapping.pattern.test(line)) && !hints.includes(mapping.hint)) {
        hints.push(mapping.hint);
      }
    }
  }

  return {
    ok: run.ok,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    steps: run.steps,
    errors: run.errors,
    warnings: run.warnings,
    logTail: run.logTail,
    logPath: run.logPath,
    durationMs: run.durationMs,
    hints,
    ...(data ? { data } : {}),
  };
}

const LSE_PROGID_HINT = "LASALScreen.Application";
