import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { newGuid, parseLcp, readLatin1, writeLatin1 } from "./lasalXml.js";
import { validateMbcsEncodable } from "./batchScript.js";
import { lasalCrc32 } from "./crc.js";

// ============================================================================
// CLASS 2 project manifest (.lcp) editing + class scaffolding.
//
// The Sigmatek batch API can create networks/objects but has no CreateClass,
// so a new class is a file-level operation: generate Class\<Name>\<Name>.st
// (class table included), register it in the .lcp <ClassFiles>/<ClassFolders>
// sections, clear the generated ProjectInternal caches, then compile. This is
// the recipe validated on the Vobra 0918A01 pilot copy (issue #25).
//
// All .lcp/.st files are ISO-8859-1: every write goes through writeLatin1 and
// every caller-supplied string is validated first.
// ============================================================================

export interface ClassServerSpec {
  name: string;
  /** ST channel type, e.g. SvrCh_DINT (default) or SvrChCmd_DINT. */
  type?: string;
  visualized?: boolean;
  retentive?: boolean;
  initialize?: boolean;
}

export interface ClassFileSpec {
  /** Path relative to the project (e.g. .\Class\PbLib\C_PbLib.cpp) or absolute. */
  path: string;
  /** For headers: emit an #include in the class .st (default true for *.h). */
  include?: boolean;
  /** For headers: set Global="true" in <HeaderFiles>. */
  global?: boolean;
  /** Optional latin1 content to write to the file. */
  content?: string;
}

export interface CreateClassOptions {
  name: string;
  folder?: string;
  revision?: string;
  comment?: string;
  company?: string;
  author?: string;
  cyclicTask?: boolean;
  realtimeTask?: boolean;
  backgroundTask?: boolean;
  defCyclicTime?: string;
  defBackgroundTime?: string;
  servers?: ClassServerSpec[];
  files?: ClassFileSpec[];
}

export interface ManifestEditResult {
  changed: boolean;
  added: string[];
  alreadyPresent: string[];
}

export interface CreateClassResult {
  className: string;
  stPath: string;
  filesWritten: string[];
  manifest: ManifestEditResult;
  cachesCleared: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_TYPE_RE = /^SvrCh[A-Za-z0-9_]*$/;

// ─── helpers ─────────────────────────────────────────────────────────────────

export function toProjectRelative(lcpPath: string, p: string): string {
  const projectDir = dirname(lcpPath);
  const abs = isAbsolute(p) ? p : resolve(projectDir, p.replace(/\\/g, "/"));
  const rel = relative(projectDir, abs).replace(/\//g, "\\");
  return rel.startsWith(".") ? rel : `.\\${rel}`;
}

export function normalizeManifestPath(rel: string): string {
  const n = rel.replace(/\//g, "\\");
  return n.startsWith(".\\") ? n : `.\\${n.replace(/^\\/, "")}`;
}

export function projectDirOf(lcpPath: string): string {
  return dirname(lcpPath);
}

/** The indent unit used by the .lcp (tabs win; otherwise two spaces). */
function indentUnit(content: string): string {
  return content.includes("\t") ? "\t" : "  ";
}

function hasPathInSection(content: string, section: "ClassFiles" | "HeaderFiles", relPath: string): boolean {
  const open = `<${section}>`;
  const close = `</${section}>`;
  const start = content.indexOf(open);
  if (start < 0) return false;
  const end = content.indexOf(close, start);
  if (end < 0) return false;
  const body = content.slice(start, end).toLowerCase();
  return body.includes(`path="${relPath.toLowerCase()}"`);
}

function insertBeforeClose(
  content: string,
  closeTag: string,
  line: string,
  afterOpenTag: string,
): { content: string; found: boolean } {
  const openIdx = content.indexOf(afterOpenTag);
  if (openIdx < 0) return { content, found: false };
  const closeIdx = content.indexOf(closeTag, openIdx);
  if (closeIdx < 0) return { content, found: false };
  const insertAt = content.lastIndexOf("\n", closeIdx) + 1;
  return { content: content.slice(0, insertAt) + line + "\n" + content.slice(insertAt), found: true };
}

// ─── manifest edits ──────────────────────────────────────────────────────────

/** Adds <File Path=".\..."/> to <ClassFiles> (idempotent). */
export function addClassFileToManifest(lcpPath: string, relPathInput: string): ManifestEditResult {
  const relPath = normalizeManifestPath(relPathInput);
  const content = readLatin1(lcpPath);
  if (hasPathInSection(content, "ClassFiles", relPath)) {
    return { changed: false, added: [], alreadyPresent: [relPath] };
  }
  const unit = indentUnit(content);
  const line = `${unit}${unit}<File Path="${relPath}"/>`;
  const { content: next, found } = insertBeforeClose(content, "</ClassFiles>", line, "<ClassFiles>");
  if (!found) throw new Error(`<ClassFiles> section not found in ${lcpPath}`);
  writeLatin1(lcpPath, next);
  return { changed: true, added: [relPath], alreadyPresent: [] };
}

/** Adds <File Path=".\..."/> to <HeaderFiles> (idempotent). */
export function addHeaderFileToManifest(lcpPath: string, relPathInput: string, global = false): ManifestEditResult {
  const relPath = normalizeManifestPath(relPathInput);
  const content = readLatin1(lcpPath);
  let changed = false;
  if (!hasPathInSection(content, "HeaderFiles", relPath)) {
    const unit = indentUnit(content);
    const globalAttr = global ? ` Global="true"` : "";
    const line = `${unit}${unit}<File Path="${relPath}"${globalAttr}/>`;
    const { content: next, found } = insertBeforeClose(content, "</HeaderFiles>", line, "<HeaderFiles>");
    if (!found) throw new Error(`<HeaderFiles> section not found in ${lcpPath}`);
    writeLatin1(lcpPath, next);
    changed = true;
  }

  // If marked global, also ensure it is included in Include/global.h if present
  if (global) {
    const globalH = join(dirname(lcpPath), "Include", "global.h");
    if (existsSync(globalH)) {
      const gContent = readLatin1(globalH);
      const cleanRel = relPath.replace(/^(\.[\\/])+/, "");
      const incLine = `#include "..\\${cleanRel}"`;
      if (!gContent.includes(incLine)) {
        let nextG: string;
        const unitIdx = gContent.indexOf('#include "unit.h"');
        if (unitIdx >= 0) {
          nextG = gContent.slice(0, unitIdx) + incLine + "\n\n" + gContent.slice(unitIdx);
        } else {
          nextG = gContent + "\n" + incLine + "\n";
        }
        writeLatin1(globalH, nextG);
        changed = true;
      }
    }
  }

  return { changed, added: changed ? [relPath] : [], alreadyPresent: changed ? [] : [relPath] };
}

/**
 * Adds <Class Name="..."/> inside <ClassFolders> (idempotent). Creates the
 * target folder when it does not exist yet.
 */
export function addClassToFolders(lcpPath: string, className: string, folderName = "IQ"): ManifestEditResult {
  const content = readLatin1(lcpPath);
  const foldersOpen = content.indexOf("<ClassFolders>");
  const foldersClose = content.indexOf("</ClassFolders>", foldersOpen);
  if (foldersOpen < 0 || foldersClose < 0) {
    throw new Error(`<ClassFolders> section not found in ${lcpPath}`);
  }
  const section = content.slice(foldersOpen, foldersClose);
  const classLower = className.toLowerCase();
  if (new RegExp(`<Class\\s+Name="${classLower}"`, "i").test(section)) {
    return { changed: false, added: [], alreadyPresent: [className] };
  }

  const unit = indentUnit(content);
  const folderOpenTag = `<Folder Name="${folderName}">`;
  const folderIdx = content.indexOf(folderOpenTag, foldersOpen);
  let next: string;
  if (folderIdx >= 0 && folderIdx < foldersClose) {
    // Walk nested <Folder> tags to find this folder's closing tag.
    let depth = 0;
    let closeIdx = -1;
    const tagRe = /<\/?Folder\b[^>]*>/g;
    tagRe.lastIndex = folderIdx;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(content)) !== null) {
      if (match.index >= foldersClose) break;
      if (match[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          closeIdx = match.index;
          break;
        }
      } else {
        depth++;
      }
    }
    if (closeIdx < 0) throw new Error(`Closing </Folder> for "${folderName}" not found`);
    const insertAt = content.lastIndexOf("\n", closeIdx) + 1;
    const classLine = `${unit}${unit}${unit}<Class Name="${className}"/>`;
    next = content.slice(0, insertAt) + classLine + "\n" + content.slice(insertAt);
  } else {
    const insertAt = content.lastIndexOf("\n", foldersClose) + 1;
    const block =
      `${unit}${unit}<Folder Name="${folderName}">\n` +
      `${unit}${unit}${unit}<Class Name="${className}"/>\n` +
      `${unit}${unit}</Folder>\n`;
    next = content.slice(0, insertAt) + block + content.slice(insertAt);
  }

  writeLatin1(lcpPath, next);
  return { changed: true, added: [className], alreadyPresent: [] };
}

/** Deletes the generated ProjectInternal caches so CLASS 2 re-reads the manifest. */
export function clearProjectCaches(lcpPath: string): string[] {
  const internal = join(dirname(lcpPath), "ProjectInternal");
  const deleted: string[] = [];
  if (!existsSync(internal)) return deleted;
  for (const name of readdirSync(internal)) {
    if (name === "BrowserInfo.bin" || name === "LobInfo.bin") {
      const p = join(internal, name);
      try {
        unlinkSync(p);
        deleted.push(p);
      } catch {
        // best effort
      }
    }
  }
  return deleted;
}

/**
 * Deletes the generated build artifacts that cache the class list: the
 * project's .lcb and Network/ConfigObjects .lob/.lba. Required when a class was
 * removed by deleting its folder (instead of the batch delete_class operation),
 * otherwise the linker fails with "Classtable '<CLASS>::@CT_' not found".
 * Forces a full relink on the next build.
 */
export function clearProjectBuildArtifacts(lcpPath: string): string[] {
  const dir = dirname(lcpPath);
  const deleted: string[] = [];
  const candidates: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().endsWith(".lcb")) candidates.push(join(dir, f));
    }
  } catch {
    // ignore
  }
  candidates.push(join(dir, "Network", "ConfigObjects.lob"));
  candidates.push(join(dir, "Network", "ConfigObjects.lba"));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
      deleted.push(p);
    } catch {
      // best effort
    }
  }
  return [...deleted, ...clearProjectCaches(lcpPath)];
}

/** Registers an existing file in the manifest (headers in <HeaderFiles>, else <ClassFiles>). */
export function registerProjectFile(
  lcpPath: string,
  filePath: string,
  opts: { header?: boolean; global?: boolean } = {},
): ManifestEditResult {
  const projectDir = dirname(lcpPath);
  const abs = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath.replace(/\\/g, "/"));
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  const rel = normalizeManifestPath(toProjectRelative(lcpPath, abs));
  const isHeader = opts.header ?? /\.h$/i.test(abs);
  const result = isHeader
    ? addHeaderFileToManifest(lcpPath, rel, opts.global ?? false)
    : addClassFileToManifest(lcpPath, rel);
  clearProjectCaches(lcpPath);
  return result;
}

// ─── class scaffolding ───────────────────────────────────────────────────────

function classTable(root: string, name: string, servers: ClassServerSpec[]): string {
  const lines = servers.map((s) => {
    const retentiveFlag = s.retentive ? "2#0000000000001000$UINT" : "2#0000000000000000$UINT";
    return `(::${root}.${s.name}.pMeth)$UINT, _CH_SVR$UINT, ${retentiveFlag}, TO_UDINT(${lasalCrc32(s.name)}), "${s.name}", `;
  });
  return (
    `FUNCTION GLOBAL TAB ${name}::@CT_\n` +
    `0$UINT,\n` +
    `2#0100000000000010$UINT, //TY_${name.toUpperCase()}\n` +
    `0$UINT, 0$UINT, (SIZEOF(::${name}))$UINT, \n` +
    `${servers.length + 1}$UINT, 0$UINT, 0$UINT, \n` +
    `TO_UDINT(${lasalCrc32(name)}), "${name}", //Class\n` +
    `TO_UDINT(0), 0, 0$UINT, 0$UINT, //Baseclass\n` +
    `//Servers:\n` +
    `(::${name}.ClassSvr.pMeth)$UINT, _CH_CMD$UINT, 2#0000000000000000$UINT, TO_UDINT(${lasalCrc32("ClassSvr")}), "ClassSvr", \n` +
    lines.map((l) => `${l}\n`).join("") +
    `//Clients:\n` +
    `END_FUNCTION\n`
  );
}

export function generateClassSource(opts: CreateClassOptions): string {
  const name = opts.name;
  const revision = opts.revision ?? "0.1";
  const company = opts.company ?? "Votech";
  const author = opts.author ?? "lasal-mcp";
  const servers = opts.servers ?? [];
  const files = opts.files ?? [];
  const cyclic = opts.cyclicTask ?? false;
  const realtime = opts.realtimeTask ?? false;
  const background = opts.backgroundTask ?? false;

  const includeFiles = files.filter((f) => (f.include ?? /\.h$/i.test(f.path)) === true);
  const includes = includeFiles
    .map((f) => {
      const rel = normalizeManifestPath(f.path).replace(/^\.\\/, "");
      return `#include "..\\..\\${rel}"`;
    })
    .join("\n");

  const serverMeta = servers
    .map((s) => {
      const visualized = s.visualized !== false ? "true" : "false";
      const initialize = s.initialize ? "true" : "false";
      const retentive = s.retentive ? "SRam" : "false";
      return `\t\t<Server Name="${s.name}" GUID="${newGuid()}" Visualized="${visualized}" Initialize="${initialize}" WriteProtected="false" Retentive="${retentive}"/>`;
    })
    .join("\n");

  const dependencies =
    files.length > 0
      ? `\t<Dependencies>\n\t\t<Files>\n` +
        files
          .map((f) => {
            const rel = normalizeManifestPath(f.path);
            const includeAttr = includeFiles.includes(f) ? ` Include="true"` : "";
            return `\t\t\t<File Path="${rel}"${includeAttr}/>`;
          })
          .join("\n") +
        `\n\t\t</Files>\n\t</Dependencies>\n`
      : "";

  const classFlags =
    `\tRealtimeTask       = "${realtime}"\n` +
    `\tCyclicTask         = "${cyclic}"\n` +
    `\tBackgroundTask     = "${background}"\n` +
    (cyclic ? `\tDefCyclictime      = "${opts.defCyclicTime ?? "cCyTb"}"\n` : "") +
    (background ? `\tDefBackground      = "${opts.defBackgroundTime ?? "cBgTb"}"\n` : "");

  const serverDecls = servers.map((s) => `\t${s.name} \t: ${s.type ?? "SvrCh_DINT"};`).join("\n");
  const storeMethods = servers
    .map(
      (s) =>
        `\t${s.name}.pMeth\t\t\t:= StoreMethod( #M_RD_DIRECT(), #M_WR_DIRECT() );\n` +
        `\tIF ${s.name}.pMeth THEN\n\t\tret_code\t:= C_OK;\n\tELSE\n\t\tret_code\t:= C_OUTOF_NEAR;\n\t\tRETURN;\n\tEND_IF;`,
    )
    .join("\n");

  const today = new Date().toISOString().slice(0, 10);

  return (
    `//This file was generated by the LASAL2 CodeGenerator  -- \n` +
    `//Please, do not edit this file (it might be overwritten by the next generator run)\n` +
    `//{{LSL_DECLARATION\n` +
    (includes ? `${includes}\n` : "") +
    `\n(*!\n<Class\n` +
    `\tName               = "${name}"\n` +
    `\tRevision           = "${revision}"\n` +
    `\tGUID               = "${newGuid()}"\n` +
    classFlags +
    `\tSigmatek           = "false"\n` +
    `\tOSInterface        = "false"\n` +
    `\tHighPriority       = "false"\n` +
    `\tAutomatic          = "false"\n` +
    `\tUpdateMode         = "Prescan"\n` +
    `\tSharedCommandTable = "true"\n` +
    `\tObjectsize         = "(284,120)"\n` +
    (opts.comment ? `\tComment            = "${opts.comment.replace(/"/g, "&quot;")}">\n` : `>\n`) +
    `\t<Channels>\n` +
    `\t\t<Server Name="ClassSvr" GUID="${newGuid()}" Visualized="false" Initialize="false" WriteProtected="true" Retentive="false"/>\n` +
    (serverMeta ? `${serverMeta}\n` : "") +
    `\t</Channels>\n` +
    dependencies +
    `\t<RevDoku>\n` +
    `\t\t<Owner Company="${company}" Author="${author}"/>\n` +
    `\t\t<Dokumentation Revision="${revision}" Date="${today}" Author="${author}" Company="${company}" Description="Created by lasal-mcp"/>\n` +
    `\t</RevDoku>\n` +
    `</Class>\n*)\n` +
    `${name} : CLASS\n` +
    `  //Servers:\n` +
    `\tClassSvr \t: SvrChCmd_DINT;\n` +
    (serverDecls ? `${serverDecls}\n` : "") +
    `  //Clients:\n` +
    `  //Variables:\n` +
    `  //Functions:\n` +
    `  //Tables:\n` +
    `\tFUNCTION @STD\n` +
    `\t\tVAR_OUTPUT\n` +
    `\t\t\tret_code\t: CONFSTATES;\n` +
    `\t\tEND_VAR;\n` +
    `\tFUNCTION GLOBAL TAB @CT_;\n` +
    `END_CLASS;\n\n` +
    `//}}LSL_DECLARATION\n\n\n` +
    classTable(name, name, servers) +
    `\n\n#define USER_CNT_${name} 0\n\n` +
    `TYPE\n\t_LSL_STD_VMETH\t: STRUCT\n\t\t\tCmdTable\t: CMDMETH;\n\t\t\tUserFcts\t: ARRAY[0..USER_CNT_${name}] OF ^Void;\n\tEND_STRUCT;\nEND_TYPE\n\n` +
    `FUNCTION ${name}::@STD\n` +
    `\tVAR_OUTPUT\n\t\tret_code\t: CONFSTATES;\n\tEND_VAR\n\tVAR\n\t\tvmt\t: _LSL_STD_VMETH;\n\tEND_VAR\n\n` +
    `\t//Command Methods\n` +
    `\tInitCmdTable (nCmd := nSTDCMD + USER_CNT_${name}, pCmd := #vmt.CmdTable);\n` +
    `\tClassSvr.pMeth\t\t:= StoreCmd (pCmd := #vmt.CmdTable, SHARED);\n\n` +
    `\tIF ClassSvr.pMeth THEN\n\t\tret_code\t:= C_OK;\n\tELSE\n\t\tret_code\t:= C_OUTOF_NEAR;\n\t\tRETURN;\n\tEND_IF;\n` +
    (storeMethods ? `${storeMethods}\n` : "") +
    `\nEND_FUNCTION\n\n` +
    `//{{LSL_IMPLEMENTATION\n`
  );
}

/** Creates a new class: sources on disk + manifest registration + cache clear. */
export function createClass(lcpPath: string, opts: CreateClassOptions): CreateClassResult {
  if (!NAME_RE.test(opts.name)) {
    throw new Error(`Invalid class name "${opts.name}": use [A-Za-z_][A-Za-z0-9_]*`);
  }
  for (const s of opts.servers ?? []) {
    if (!NAME_RE.test(s.name)) throw new Error(`Invalid server name "${s.name}"`);
    const t = s.type ?? "SvrCh_DINT";
    if (!SERVER_TYPE_RE.test(t)) throw new Error(`Invalid server type "${t}" for "${s.name}" (expected SvrCh_*)`);
  }
  const lcp = parseLcp(lcpPath);
  const stRel = normalizeManifestPath(`.\\Class\\${opts.name}\\${opts.name}.st`);
  const stAbs = resolve(lcp.projectDir, stRel.replace(/\\/g, "/"));
  if (existsSync(stAbs) || lcp.classFiles.some((c) => c.relativePath.toLowerCase() === stRel.toLowerCase())) {
    throw new Error(`Class "${opts.name}" already exists (${stAbs})`);
  }
  // Normalize dependency paths to project-relative form before code generation.
  const normalizedOpts: CreateClassOptions = {
    ...opts,
    files: (opts.files ?? []).map((f) => ({ ...f, path: toProjectRelative(lcpPath, f.path) })),
  };
  const content = generateClassSource(normalizedOpts);
  validateMbcsEncodable(content);
  for (const f of opts.files ?? []) {
    if (f.content !== undefined) validateMbcsEncodable(f.content);
  }

  const written: string[] = [];
  const manifestAdded: string[] = [];
  const already: string[] = [];
  try {
    mkdirSync(dirname(stAbs), { recursive: true });
    writeLatin1(stAbs, content);
    written.push(stAbs);

    for (const f of opts.files ?? []) {
      if (f.content === undefined) continue;
      const abs = isAbsolute(f.path) ? f.path : resolve(lcp.projectDir, f.path.replace(/\\/g, "/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeLatin1(abs, f.content);
      written.push(abs);
    }

    const stEdit = addClassFileToManifest(lcpPath, stRel);
    manifestAdded.push(...stEdit.added);
    already.push(...stEdit.alreadyPresent);
    for (const f of opts.files ?? []) {
      if (f.content === undefined && !existsSync(isAbsolute(f.path) ? f.path : resolve(lcp.projectDir, f.path))) {
        throw new Error(`Dependency file not found: ${f.path}`);
      }
      const rel = toProjectRelative(lcpPath, f.path);
      const isHeader = /\.h$/i.test(f.path);
      const edit = isHeader
        ? addHeaderFileToManifest(lcpPath, rel, f.global ?? false)
        : addClassFileToManifest(lcpPath, rel);
      manifestAdded.push(...edit.added);
      already.push(...edit.alreadyPresent);
    }
    const folders = addClassToFolders(lcpPath, opts.name, opts.folder ?? "IQ");
    manifestAdded.push(...folders.added);
    already.push(...folders.alreadyPresent);
  } catch (err) {
    // best-effort rollback of the files we created
    for (const w of written) {
      try {
        rmSync(w, { force: true });
      } catch {
        // ignore
      }
    }
    throw err;
  }

  const cachesCleared = clearProjectCaches(lcpPath);
  return {
    className: opts.name,
    stPath: stAbs,
    filesWritten: written,
    manifest: { changed: manifestAdded.length > 0, added: manifestAdded, alreadyPresent: already },
    cachesCleared,
  };
}
