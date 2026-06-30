import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, basename } from "path";
import { XMLParser } from "fast-xml-parser";
import { randomUUID } from "crypto";

// ─── ISO-8859-1 I/O ─────────────────────────────────────────────────────────

export function readLatin1(path: string): string {
  return readFileSync(path, "latin1");
}

export function writeLatin1(path: string, content: string): void {
  writeFileSync(path, content, "latin1");
}

// ─── XML Parser (read-only) ──────────────────────────────────────────────────

// Tags that can appear multiple times as siblings
const ALWAYS_ARRAY = new Set([
  "File", "Server", "Client", "Object", "Connection", "RemoteObject", "Folder",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name, jpath) => {
    if (ALWAYS_ARRAY.has(name)) return true;
    const path = String(jpath);
    // <Network> inside <Networks> (sub-networks of objects) can be multiple
    if (name === "Network" && path.endsWith(".Networks.Network")) return true;
    // <Class> inside SigmatekFolders
    if (name === "Class" && path.includes("SigmatekFolders")) return true;
    return false;
  },
  parseAttributeValue: false, // keep everything as strings
});

// ─── GUID helper ─────────────────────────────────────────────────────────────

export function newGuid(): string {
  return `{${randomUUID().toUpperCase()}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// .lcp parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface LcpClassEntry { relativePath: string; absPath: string }
export interface LcpNetworkEntry { relativePath: string; absPath: string }

export interface LcpInfo {
  projectName: string;
  lcpPath: string;
  projectDir: string;
  classFiles: LcpClassEntry[];
  networkFiles: LcpNetworkEntry[];
  classDir: string;
  networkDir: string;
}

export function parseLcp(lcpPath: string): LcpInfo {
  const raw = readLatin1(lcpPath);
  const doc = parser.parse(raw);
  const proj = doc.Project ?? {};
  const projectDir = dirname(lcpPath);

  function abs(rel: string) {
    return resolve(projectDir, rel.replace(/\\/g, "/"));
  }

  const classFiles: LcpClassEntry[] = [];
  for (const f of (proj.ClassFiles?.File ?? []) as any[]) {
    if (f?.["@_Path"]) classFiles.push({ relativePath: f["@_Path"], absPath: abs(f["@_Path"]) });
  }

  const networkFiles: LcpNetworkEntry[] = [];
  for (const f of (proj.NetworkFiles?.File ?? []) as any[]) {
    if (f?.["@_Path"]) networkFiles.push({ relativePath: f["@_Path"], absPath: abs(f["@_Path"]) });
  }

  const dirs = proj.Options?.Directories ?? {};
  const classDir = abs(dirs["@_Class"] ?? ".\\Class\\");
  const networkDir = abs(dirs["@_Network"] ?? ".\\Network\\");

  return {
    projectName: proj["@_Name"] ?? basename(lcpPath, ".lcp"),
    lcpPath,
    projectDir,
    classFiles,
    networkFiles,
    classDir,
    networkDir,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// .st parsing  (extract (*! … !*) XML block → parse channels)
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerChannel {
  name: string;
  guid: string;
  visualized: boolean;
  initialize: boolean;
  defValue?: string;
  writeProtected: boolean;
  retentive: string;
  comment?: string;
}

export interface ClientChannel {
  name: string;
  required: boolean;
  internal: boolean;
  comment?: string;
}

export interface StClassInfo {
  name: string;
  revision?: string;
  guid?: string;
  cyclicTask: boolean;
  realtimeTask: boolean;
  backgroundTask: boolean;
  servers: ServerChannel[];
  clients: ClientChannel[];
}

function extractStBlock(content: string): { pre: string; xml: string; post: string } {
  const START = "(*!";
  const END = "*)";
  const si = content.indexOf(START);
  if (si < 0) throw new Error("No (*! declaration block found in .st file");
  // Find the *) that closes the (*! block (the first *) after the opening marker)
  const ei = content.indexOf(END, si + START.length);
  if (ei < 0) throw new Error("No closing *) found for (*! block in .st file");
  return {
    pre: content.slice(0, si + START.length),
    xml: content.slice(si + START.length, ei),
    post: content.slice(ei),
  };
}

export function parseStClass(stPath: string): StClassInfo {
  const raw = readLatin1(stPath);
  const { xml } = extractStBlock(raw);
  const doc = parser.parse(xml);
  // Class is the root element (single, not array)
  const cls = doc.Class ?? {};
  // Channels is a single element containing Server[] and Client[]
  const channels = cls.Channels ?? {};

  const servers: ServerChannel[] = [];
  for (const s of toArray(channels.Server)) {
    servers.push({
      name: s["@_Name"] ?? "",
      guid: s["@_GUID"] ?? newGuid(),
      visualized: s["@_Visualized"] === "true",
      initialize: s["@_Initialize"] === "true",
      defValue: s["@_DefValue"],
      writeProtected: s["@_WriteProtected"] === "true",
      retentive: s["@_Retentive"] ?? "false",
      comment: s["@_Comment"],
    });
  }

  const clients: ClientChannel[] = [];
  for (const c of toArray(channels.Client)) {
    clients.push({
      name: c["@_Name"] ?? "",
      required: c["@_Required"] === "true",
      internal: c["@_Internal"] === "true",
      comment: c["@_Comment"],
    });
  }

  return {
    name: cls["@_Name"] ?? basename(stPath, ".st"),
    revision: cls["@_Revision"],
    guid: cls["@_GUID"],
    cyclicTask: cls["@_CyclicTask"] === "true",
    realtimeTask: cls["@_RealtimeTask"] === "true",
    backgroundTask: cls["@_BackgroundTask"] === "true",
    servers,
    clients,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// .lcn parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface LcnObject {
  name: string;
  guid?: string;
  className: string;
  position?: string;
  channelValues: Record<string, string>; // channel name → init value
}

export interface LcnConnection {
  source: string;   // "ObjName.ClientName"
  destination: string; // "ObjName.ServerName"
  remote?: boolean;
  station?: string;
}

export interface LcnInfo {
  name: string;
  lcnPath: string;
  objects: LcnObject[];   // flat list (top-level + nested sub-objects)
  connections: LcnConnection[];
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function collectObjects(components: any[]): LcnObject[] {
  const result: LcnObject[] = [];
  for (const obj of toArray(components)) {
    const channels = obj.Channels;
    const channelValues: Record<string, string> = {};
    for (const sv of toArray(channels?.Server)) {
      if (sv["@_Value"]) channelValues[sv["@_Name"]] = sv["@_Value"];
    }
    for (const cl of toArray(channels?.Client)) {
      if (cl["@_Value"]) channelValues[cl["@_Name"]] = cl["@_Value"];
    }
    result.push({
      name: obj["@_Name"] ?? "",
      guid: obj["@_GUID"],
      className: obj["@_Class"] ?? "",
      position: obj["@_Position"],
      channelValues,
    });
    // recurse into sub-networks (Network may be array or single)
    for (const subNet of toArray(obj.Networks?.Network)) {
      result.push(...collectObjects(toArray(subNet.Components?.Object)));
    }
  }
  return result;
}

function collectConnections(network: any): LcnConnection[] {
  const result: LcnConnection[] = [];
  for (const conn of toArray(network.Connections?.Connection)) {
    result.push({
      source: conn["@_Source"] ?? "",
      destination: conn["@_Destination"] ?? "",
      remote: !!conn["@_Station"],
      station: conn["@_Station"],
    });
  }
  // recurse into sub-networks inside objects
  for (const obj of toArray(network.Components?.Object)) {
    for (const subNet of toArray(obj.Networks?.Network)) {
      result.push(...collectConnections(subNet));
    }
  }
  return result;
}

export function parseLcn(lcnPath: string): LcnInfo {
  const raw = readLatin1(lcnPath);
  const doc = parser.parse(raw);
  // Network is the root element (single, not array)
  const net = doc.Network ?? {};

  return {
    name: net["@_Name"] ?? basename(lcnPath, ".lcn"),
    lcnPath,
    objects: collectObjects(toArray(net.Components?.Object)),
    connections: collectConnections(net),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// .st string editing  (targeted, preserves formatting + encoding)
// ─────────────────────────────────────────────────────────────────────────────

function editStBlock(stPath: string, editFn: (xml: string) => string): void {
  const raw = readLatin1(stPath);
  const { pre, xml, post } = extractStBlock(raw);
  const newXml = editFn(xml);
  writeLatin1(stPath, pre + newXml + post);
}

function serverLineRegex(name: string): RegExp {
  // Matches the full line of a <Server Name="X" ... /> element
  return new RegExp(`[ \\t]*<Server\\s+Name\\s*=\\s*"${escapeRe(name)}"[^\\n]*\\n`, "");
}

function clientLineRegex(name: string): RegExp {
  return new RegExp(`[ \\t]*<Client\\s+Name\\s*=\\s*"${escapeRe(name)}"[^\\n]*\\n`, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serverXmlLine(s: ServerChannel, indent: string, eol = "\n"): string {
  let line = `${indent}<Server Name="${s.name}" GUID="${s.guid}" Visualized="${s.visualized}" Initialize="${s.initialize}"`;
  if (s.defValue !== undefined) line += ` DefValue="${s.defValue}"`;
  line += ` WriteProtected="${s.writeProtected}" Retentive="${s.retentive}"`;
  if (s.comment) line += ` Comment="${s.comment}"`;
  line += "/>" + eol;
  return line;
}

function clientXmlLine(c: ClientChannel, indent: string, eol = "\n"): string {
  let line = `${indent}<Client Name="${c.name}" Required="${c.required}" Internal="${c.internal}"`;
  if (c.comment) line += ` Comment="${c.comment}"`;
  line += "/>" + eol;
  return line;
}

function detectChannelsIndent(xml: string): string {
  const m = xml.match(/(\t+)<(?:Server|Client)\s+Name/);
  return m ? m[1] : "\t\t";
}

export function addServerToSt(stPath: string, server: Omit<ServerChannel, "guid"> & { guid?: string }): void {
  const ch = { ...server, guid: server.guid ?? newGuid() } as ServerChannel;
  editStBlock(stPath, (xml) => {
    const indent = detectChannelsIndent(xml);
    const eol = xml.includes("\r\n") ? "\r\n" : "\n";
    const line = serverXmlLine(ch, indent, eol);
    // Replace `(closingIndent)</Channels>` preserving the closing tag's own indent
    return xml.replace(/([ \t]*)<\/Channels>/, (_, closingIndent) => line + closingIndent + "</Channels>");
  });
}

export function removeServerFromSt(stPath: string, name: string): void {
  editStBlock(stPath, (xml) => xml.replace(serverLineRegex(name), ""));
}

export function renameServerInSt(stPath: string, oldName: string, newName: string): void {
  editStBlock(stPath, (xml) => {
    const re = new RegExp(`(<Server\\s+Name\\s*=\\s*")${escapeRe(oldName)}"`, "");
    return xml.replace(re, `$1${newName}"`);
  });
}

export function addClientToSt(stPath: string, client: ClientChannel): void {
  editStBlock(stPath, (xml) => {
    const indent = detectChannelsIndent(xml);
    const eol = xml.includes("\r\n") ? "\r\n" : "\n";
    const line = clientXmlLine(client, indent, eol);
    return xml.replace(/([ \t]*)<\/Channels>/, (_, closingIndent) => line + closingIndent + "</Channels>");
  });
}

export function removeClientFromSt(stPath: string, name: string): void {
  editStBlock(stPath, (xml) => xml.replace(clientLineRegex(name), ""));
}

export function renameClientInSt(stPath: string, oldName: string, newName: string): void {
  editStBlock(stPath, (xml) => {
    const re = new RegExp(`(<Client\\s+Name\\s*=\\s*")${escapeRe(oldName)}"`, "");
    return xml.replace(re, `$1${newName}"`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// .lcn cascade edits  (rename/remove channel references + connections)
// ─────────────────────────────────────────────────────────────────────────────

// Applies editFn to each <Object ... Class="className" ...> block in the lcn content.
// editFn receives the inner content between <Object ...> and </Object> and returns it modified.
function editObjectsOfClass(
  content: string,
  className: string,
  editFn: (objectBlock: string) => string
): string {
  // We match the Class attribute value in the opening <Object tag
  // then capture up to the matching </Object>
  // Strategy: find each occurrence, replace in-place

  let result = content;
  let searchFrom = 0;

  while (true) {
    // Find the next <Object...> tag with this class
    const classAttrRe = new RegExp(
      `<Object(?=[^>]*\\bClass\\s*=\\s*"${escapeRe(className)}"[^>]*>)`
    );
    const objTagRe = new RegExp(
      `<Object(?=[^>]*\\bClass\\s*=\\s*"${escapeRe(className)}"[^>]*)([^>]*)>`,
      "s"  // dotAll
    );

    const searchStr = result.slice(searchFrom);
    const match = objTagRe.exec(searchStr);
    if (!match) break;

    const matchStart = searchFrom + match.index;
    const tagEnd = matchStart + match[0].length;

    // find the matching </Object>
    let depth = 1;
    let pos = tagEnd;
    while (depth > 0 && pos < result.length) {
      const openIdx = result.indexOf("<Object", pos);
      const closeIdx = result.indexOf("</Object>", pos);
      if (closeIdx < 0) break;
      if (openIdx >= 0 && openIdx < closeIdx) {
        depth++;
        pos = openIdx + 7;
      } else {
        depth--;
        if (depth === 0) {
          // [matchStart .. closeIdx + 9] is the full <Object>...</Object>
          const fullBlock = result.slice(matchStart, closeIdx + 9);
          const inner = fullBlock.slice(match[0].length, fullBlock.length - 9);
          const newInner = editFn(inner);
          const newBlock = fullBlock.slice(0, match[0].length) + newInner + "</Object>";
          result = result.slice(0, matchStart) + newBlock + result.slice(closeIdx + 9);
          searchFrom = matchStart + newBlock.length;
        } else {
          pos = closeIdx + 9;
        }
      }
    }
    if (depth > 0) break; // safety: unmatched tag
  }
  return result;
}

export function cascadeRenameServerInLcn(lcnPath: string, className: string, oldName: string, newName: string): void {
  let content = readLatin1(lcnPath);

  // 1. Rename in object channels
  content = editObjectsOfClass(content, className, (inner) => {
    const re = new RegExp(
      `(<Server\\s+Name\\s*=\\s*")${escapeRe(oldName)}(")`,
      "g"
    );
    return inner.replace(re, `$1${newName}$2`);
  });

  // 2. Rename in Connections: Destination="ObjName.OldName" → "ObjName.NewName"
  // We must only rename connections that target objects of this class.
  // Since we don't track which objects belong to which class in connections,
  // we rename any destination ending in .OldName that likely belongs to this class.
  // (The full accuracy requires cross-referencing object names - done in the tool layer.)
  // Here we do the raw rename; the caller passes a pre-filtered set of object names.
  content = content.replace(
    new RegExp(`(Destination\\s*=\\s*"[^".]+\\.)(${escapeRe(oldName)}")`, "g"),
    `$1${newName}"`
  );

  writeLatin1(lcnPath, content);
}

export function cascadeRenameClientInLcn(
  lcnPath: string,
  className: string,
  oldName: string,
  newName: string,
  objectNames: string[] // objects of this class in this network
): void {
  let content = readLatin1(lcnPath);

  // 1. Rename in object channels
  content = editObjectsOfClass(content, className, (inner) => {
    const re = new RegExp(
      `(<Client\\s+Name\\s*=\\s*")${escapeRe(oldName)}(")`,
      "g"
    );
    return inner.replace(re, `$1${newName}$2`);
  });

  // 2. Rename in Connections Source="ObjName.OldClientName"
  for (const objName of objectNames) {
    content = content.replace(
      new RegExp(`(Source\\s*=\\s*")${escapeRe(objName)}\\.${escapeRe(oldName)}(")`, "g"),
      `$1${objName}.${newName}$2`
    );
  }

  writeLatin1(lcnPath, content);
}

export function cascadeRemoveClientFromLcn(
  lcnPath: string,
  className: string,
  clientName: string,
  objectNames: string[]
): void {
  let content = readLatin1(lcnPath);

  // 1. Remove from object channels
  content = editObjectsOfClass(content, className, (inner) =>
    inner.replace(clientLineRegex(clientName), "")
  );

  // 2. Remove Connection lines that source from these objects' removed client
  for (const objName of objectNames) {
    content = content.replace(
      new RegExp(
        `[ \\t]*<Connection[^>]*Source\\s*=\\s*"${escapeRe(objName)}\\.${escapeRe(clientName)}"[^\\n]*\\n`,
        "g"
      ),
      ""
    );
  }

  writeLatin1(lcnPath, content);
}

export function cascadeRemoveServerFromLcn(
  lcnPath: string,
  className: string,
  serverName: string,
  objectNames: string[]
): void {
  let content = readLatin1(lcnPath);

  // 1. Remove from object channels
  content = editObjectsOfClass(content, className, (inner) =>
    inner.replace(serverLineRegex(serverName), "")
  );

  // 2. Remove Connection lines that target these objects' removed server
  for (const objName of objectNames) {
    content = content.replace(
      new RegExp(
        `[ \\t]*<Connection[^>]*Destination\\s*=\\s*"${escapeRe(objName)}\\.${escapeRe(serverName)}"[^\\n]*\\n`,
        "g"
      ),
      ""
    );
  }

  writeLatin1(lcnPath, content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Find objects of a class across all .lcn files
// ─────────────────────────────────────────────────────────────────────────────

export function findObjectsOfClass(
  lcnPaths: string[],
  className: string
): Map<string, string[]> {
  const result = new Map<string, string[]>(); // lcnPath → object names
  for (const lcnPath of lcnPaths) {
    if (!existsSync(lcnPath)) continue;
    const info = parseLcn(lcnPath);
    const names = info.objects
      .filter((o) => o.className === className)
      .map((o) => o.name);
    if (names.length > 0) result.set(lcnPath, names);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// ST body parsing  (sections between *) and end-of-file)
// ─────────────────────────────────────────────────────────────────────────────

export interface StVariable {
  name: string;
  type: string;
}

export interface StMethodParam {
  name: string;
  type: string;
  direction: "input" | "output" | "in_out";
}

export interface StMethodSig {
  name: string;
  modifiers: string[];   // e.g. ["VIRTUAL", "GLOBAL"]
  params: StMethodParam[];
}

export interface StBodyInfo {
  variables: StVariable[];
  methods: StMethodSig[];
}

/** Split a .st file into its major sections. */
function splitStSections(content: string): {
  pre: string;        // up to and including *)
  classPart: string;  // CLASS...END_CLASS; + pragmas (between *) and //}}LSL_DECLARATION)
  implPart: string;   // //}}LSL_DECLARATION onwards (method implementations)
} {
  const xmlEnd = (() => {
    const si = content.indexOf("(*!");
    if (si < 0) return -1;
    return content.indexOf("*)", si + 3);
  })();
  if (xmlEnd < 0) return { pre: content, classPart: "", implPart: "" };

  const afterXml = xmlEnd + 2; // position after *)
  const implIdx = content.indexOf("//}}LSL_DECLARATION", afterXml);
  if (implIdx < 0) {
    return {
      pre: content.slice(0, afterXml),
      classPart: content.slice(afterXml),
      implPart: "",
    };
  }
  return {
    pre: content.slice(0, afterXml),
    classPart: content.slice(afterXml, implIdx),
    implPart: content.slice(implIdx),
  };
}

/** Return the line range for a named section (e.g. "Variables") in the class body. */
function findSectionRange(
  text: string,
  sectionMarker: string
): { start: number; end: number } | null {
  const markerRe = new RegExp(`\\/\\/\\s*${escapeRe(sectionMarker)}\\s*:`, "i");
  const m = markerRe.exec(text);
  if (!m) return null;

  const start = m.index + m[0].length; // character after the marker line's colon

  // Find the next section marker line (// + word) or END_CLASS;.
  // Use multiline mode with ^[ \t]* so n.index lands at the START of the line,
  // not mid-line at the //, keeping the marker's leading whitespace in slice(range.end).
  const nextSection = new RegExp(
    `^[ \\t]*(?:\\/\\/[A-Za-z]|END_CLASS\\s*;)`,
    "gm"
  );
  nextSection.lastIndex = start;
  const n = nextSection.exec(text);
  const end = n ? n.index : text.length;
  return { start, end };
}

/** Parse variables from the class body text. */
function parseVariablesFromBody(classPart: string): StVariable[] {
  const range = findSectionRange(classPart, "Variables");
  if (!range) return [];
  const section = classPart.slice(range.start, range.end);
  const result: StVariable[] = [];
  for (const line of section.split("\n")) {
    // Match: optional-whitespace Name optional-whitespace : Type ;
    const m = line.match(/^\s+(\w+)\s*:\s*(.+?)\s*;?\s*$/);
    if (m && m[1] && m[2]) {
      result.push({ name: m[1], type: m[2].trim() });
    }
  }
  return result;
}

/** Parse method signatures from the class body Functions section. */
function parseMethodsFromBody(classPart: string): StMethodSig[] {
  const range = findSectionRange(classPart, "Functions");
  if (!range) return [];
  const section = classPart.slice(range.start, range.end);
  const result: StMethodSig[] = [];

  // Find each FUNCTION declaration
  const funcRe = /\bFUNCTION\b([\s\w]*?)\s+(\w+)\s*(?:;|\r?\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(section)) !== null) {
    const modStr = m[1].trim();
    const name = m[2];
    if (name.startsWith("@")) continue; // system tables
    const modifiers = modStr ? modStr.split(/\s+/).filter(Boolean) : [];
    result.push({ name, modifiers, params: [] }); // params parsing omitted for brevity
  }
  return result;
}

export function parseStBody(stPath: string): StBodyInfo {
  const content = readLatin1(stPath);
  const { classPart } = splitStSections(content);
  return {
    variables: parseVariablesFromBody(classPart),
    methods: parseMethodsFromBody(classPart),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ST body channel type declarations  (//Servers: and //Clients: sections)
// These are in sync with the XML block — update both together when adding channels.
// ─────────────────────────────────────────────────────────────────────────────

function editStBody(stPath: string, editFn: (content: string) => string): void {
  writeLatin1(stPath, editFn(readLatin1(stPath)));
}

function insertIntoSection(
  text: string,
  sectionMarker: string,
  newLine: string
): string {
  const range = findSectionRange(text, sectionMarker);
  if (!range) return text; // section not found — leave unchanged
  // Insert before the end of the section
  return text.slice(0, range.end) + newLine + text.slice(range.end);
}

function removeLineFromSection(
  text: string,
  sectionMarker: string,
  namePattern: string
): string {
  const range = findSectionRange(text, sectionMarker);
  if (!range) return text;
  const section = text.slice(range.start, range.end);
  const re = new RegExp(`[ \\t]*${escapeRe(namePattern)}[ \\t]*:[^\\n]*\\n`, "");
  const newSection = section.replace(re, "");
  return text.slice(0, range.start) + newSection + text.slice(range.end);
}

export function addServerTypeToStBody(stPath: string, name: string, stType: string): void {
  editStBody(stPath, (c) => {
    const eol = c.includes("\r\n") ? "\r\n" : "\n";
    return insertIntoSection(c, "Servers", `\t${name} \t: ${stType};${eol}`);
  });
}

export function removeServerTypeFromStBody(stPath: string, name: string): void {
  editStBody(stPath, (c) => removeLineFromSection(c, "Servers", name));
}

export function renameServerInStBody(stPath: string, oldName: string, newName: string): void {
  editStBody(stPath, (c) => {
    const { pre, classPart, implPart } = splitStSections(c);
    const range = findSectionRange(classPart, "Servers");
    if (!range) return c;
    const newClassPart = classPart.replace(
      new RegExp(`\\b${escapeRe(oldName)}\\b(?=[ \\t]*:)`, "g"),
      newName
    );
    return pre + newClassPart + implPart;
  });
}

export function addClientTypeToStBody(stPath: string, name: string, stType: string): void {
  editStBody(stPath, (c) => {
    const eol = c.includes("\r\n") ? "\r\n" : "\n";
    return insertIntoSection(c, "Clients", `\t${name} \t: ${stType};${eol}`);
  });
}

export function removeClientTypeFromStBody(stPath: string, name: string): void {
  editStBody(stPath, (c) => removeLineFromSection(c, "Clients", name));
}

export function renameClientInStBody(stPath: string, oldName: string, newName: string): void {
  editStBody(stPath, (c) => {
    const { pre, classPart, implPart } = splitStSections(c);
    const newClassPart = classPart.replace(
      new RegExp(`\\b${escapeRe(oldName)}\\b(?=[ \\t]*:)`, "g"),
      newName
    );
    return pre + newClassPart + implPart;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Variables
// ─────────────────────────────────────────────────────────────────────────────

export function addVariableToSt(stPath: string, name: string, type: string): void {
  editStBody(stPath, (c) => {
    const eol = c.includes("\r\n") ? "\r\n" : "\n";
    return insertIntoSection(c, "Variables", `\t\t${name} \t: ${type};${eol}`);
  });
}

export function removeVariableFromSt(stPath: string, name: string): void {
  editStBody(stPath, (c) => removeLineFromSection(c, "Variables", name));
}

/**
 * Rename a variable in the class declaration.
 * If renameInBody is true, also renames whole-word occurrences in the
 * implementation section (use with care — may affect unrelated identifiers).
 * Returns the number of replacements made in the implementation section.
 */
export function renameVariableInSt(
  stPath: string,
  oldName: string,
  newName: string,
  renameInBody = false
): number {
  let bodyReplacements = 0;
  editStBody(stPath, (content) => {
    const { pre, classPart, implPart } = splitStSections(content);

    // 1. Rename in the class declaration (variables section only)
    const varRange = findSectionRange(classPart, "Variables");
    let newClassPart = classPart;
    if (varRange) {
      const section = classPart.slice(varRange.start, varRange.end);
      const newSection = section.replace(
        new RegExp(`\\b${escapeRe(oldName)}\\b`, "g"),
        newName
      );
      newClassPart =
        classPart.slice(0, varRange.start) + newSection + classPart.slice(varRange.end);
    }

    // 2. Optionally rename in the implementation section
    let newImplPart = implPart;
    if (renameInBody) {
      const re = new RegExp(`\\b${escapeRe(oldName)}\\b`, "gi");
      newImplPart = implPart.replace(re, (m) => {
        bodyReplacements++;
        // Preserve case of first letter
        return newName[0] === oldName[0]
          ? newName
          : m[0] === m[0].toUpperCase()
          ? newName[0].toUpperCase() + newName.slice(1)
          : newName;
      });
    }

    return pre + newClassPart + newImplPart;
  });
  return bodyReplacements;
}

// ─────────────────────────────────────────────────────────────────────────────
// Methods
// ─────────────────────────────────────────────────────────────────────────────

export interface AddMethodOptions {
  name: string;
  modifiers?: string[];  // e.g. ["VIRTUAL", "GLOBAL"]
  params?: Array<{ name: string; type: string; direction?: "input" | "output" | "in_out" }>;
  body?: string;         // implementation body; default is "// TODO: implement"
}

function buildMethodDeclaration(opts: AddMethodOptions, eol = "\n"): string {
  const modStr = opts.modifiers?.length ? opts.modifiers.join(" ") + " " : "";
  const lines: string[] = [`\tFUNCTION ${modStr}${opts.name}`];
  const inputs = (opts.params ?? []).filter((p) => !p.direction || p.direction === "input");
  const outputs = (opts.params ?? []).filter((p) => p.direction === "output");
  const inouts = (opts.params ?? []).filter((p) => p.direction === "in_out");

  if (inputs.length) {
    lines.push("\t\tVAR_INPUT");
    for (const p of inputs) lines.push(`\t\t\t${p.name} \t: ${p.type};`);
    lines.push("\t\tEND_VAR");
  }
  if (outputs.length) {
    lines.push("\t\tVAR_OUTPUT");
    for (const p of outputs) lines.push(`\t\t\t${p.name} \t: ${p.type};`);
    lines.push("\t\tEND_VAR");
  }
  if (inouts.length) {
    lines.push("\t\tVAR_IN_OUT");
    for (const p of inouts) lines.push(`\t\t\t${p.name} \t: ${p.type};`);
    lines.push("\t\tEND_VAR");
  }
  lines.push("\t\t;"); // declaration ends with ;
  return lines.join(eol) + eol;
}

function buildMethodImplementation(className: string, opts: AddMethodOptions, eol = "\n"): string {
  const lines: string[] = [`FUNCTION ${className}::${opts.name}`];
  const inputs = (opts.params ?? []).filter((p) => !p.direction || p.direction === "input");
  const outputs = (opts.params ?? []).filter((p) => p.direction === "output");
  const inouts = (opts.params ?? []).filter((p) => p.direction === "in_out");

  if (inputs.length) {
    lines.push("\tVAR_INPUT");
    for (const p of inputs) lines.push(`\t\t${p.name} \t: ${p.type};`);
    lines.push("\tEND_VAR");
  }
  if (outputs.length) {
    lines.push("\tVAR_OUTPUT");
    for (const p of outputs) lines.push(`\t\t${p.name} \t: ${p.type};`);
    lines.push("\tEND_VAR");
  }
  if (inouts.length) {
    lines.push("\tVAR_IN_OUT");
    for (const p of inouts) lines.push(`\t\t${p.name} \t: ${p.type};`);
    lines.push("\tEND_VAR");
  }
  lines.push("");
  lines.push("\t" + (opts.body ?? `// TODO: implement ${opts.name}`));
  lines.push("");
  lines.push("END_FUNCTION");
  return lines.join(eol) + eol + eol;
}

export function addMethodToSt(stPath: string, className: string, opts: AddMethodOptions): void {
  editStBody(stPath, (content) => {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const { pre, classPart, implPart } = splitStSections(content);

    // 1. Add declaration to //Functions: section (before //Tables: or END_CLASS;)
    const funcRange = findSectionRange(classPart, "Functions");
    let newClassPart = classPart;
    if (funcRange) {
      const decl = buildMethodDeclaration(opts, eol);
      newClassPart =
        classPart.slice(0, funcRange.end) + decl + classPart.slice(funcRange.end);
    }

    // 2. Add implementation to end of implPart
    const impl = buildMethodImplementation(className, opts, eol);
    const newImplPart = implPart + impl;

    return pre + newClassPart + newImplPart;
  });
}

/** Find a method implementation block: FUNCTION ClassName::Name ... END_FUNCTION */
function findMethodImplRange(
  implPart: string,
  className: string,
  methodName: string
): { start: number; end: number } | null {
  const headerRe = new RegExp(
    `FUNCTION\\s+${escapeRe(className)}::${escapeRe(methodName)}\\b`
  );
  const m = headerRe.exec(implPart);
  if (!m) return null;
  const start = m.index;
  const endRe = /\bEND_FUNCTION\b/g;
  endRe.lastIndex = start;
  const em = endRe.exec(implPart);
  if (!em) return null;
  // include trailing newlines
  let end = em.index + em[0].length;
  while (end < implPart.length && (implPart[end] === "\r" || implPart[end] === "\n")) end++;
  return { start, end };
}

/** Find a method declaration in the Functions section (multi-line, ends with ;) */
function findMethodDeclRange(
  classPart: string,
  methodName: string
): { start: number; end: number } | null {
  const range = findSectionRange(classPart, "Functions");
  if (!range) return null;
  const section = classPart.slice(range.start, range.end);

  // Match FUNCTION [modifiers] methodName
  const headerRe = new RegExp(
    `[ \\t]*FUNCTION(?:[\\s\\w]*?)\\s+${escapeRe(methodName)}\\b`
  );
  const m = headerRe.exec(section);
  if (!m) return null;

  const declStart = range.start + m.index;

  // Scan forward tracking VAR block depth to find the closing ; at depth 0.
  // Params have ; inside VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT blocks (depth > 0).
  // The declaration-closing ; is always at depth 0 (on the FUNCTION line itself
  // for no-param methods, or on a separate line / end of last END_VAR for parameterised ones).
  const tokenRe = /\bVAR(?:_INPUT|_OUTPUT|_IN_OUT)\b|\bEND_VAR\b|;/g;
  tokenRe.lastIndex = range.start + m.index + m[0].length;
  let depth = 0;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(classPart)) !== null) {
    if (token.index >= range.end) break;
    if (token[0] === "END_VAR") {
      depth--;
    } else if (token[0] !== ";") {
      depth++; // VAR_INPUT, VAR_OUTPUT, or VAR_IN_OUT
    } else if (depth === 0) {
      let declEnd = token.index + 1;
      while (declEnd < classPart.length && (classPart[declEnd] === "\r" || classPart[declEnd] === "\n")) declEnd++;
      return { start: declStart, end: declEnd };
    }
  }
  return null;
}

export function removeMethodFromSt(stPath: string, className: string, name: string): void {
  editStBody(stPath, (content) => {
    const { pre, classPart, implPart } = splitStSections(content);

    // Remove declaration
    const declRange = findMethodDeclRange(classPart, name);
    let newClassPart = classPart;
    if (declRange) {
      newClassPart =
        classPart.slice(0, declRange.start) + classPart.slice(declRange.end);
    }

    // Remove implementation
    const implRange = findMethodImplRange(implPart, className, name);
    let newImplPart = implPart;
    if (implRange) {
      newImplPart =
        implPart.slice(0, implRange.start) + implPart.slice(implRange.end);
    }

    return pre + newClassPart + newImplPart;
  });
}

export function renameMethodInSt(
  stPath: string,
  className: string,
  oldName: string,
  newName: string
): void {
  editStBody(stPath, (content) => {
    const { pre, classPart, implPart } = splitStSections(content);

    // 1. Rename in the Functions section declaration header
    const funcRange = findSectionRange(classPart, "Functions");
    let newClassPart = classPart;
    if (funcRange) {
      const section = classPart.slice(funcRange.start, funcRange.end);
      const newSection = section.replace(
        new RegExp(
          `(FUNCTION(?:[\\s\\w]*)\\s+)${escapeRe(oldName)}\\b`,
          "g"
        ),
        `$1${newName}`
      );
      newClassPart =
        classPart.slice(0, funcRange.start) + newSection + classPart.slice(funcRange.end);
    }

    // 2. Rename implementation header: FUNCTION ClassName::OldName
    const newImplPart = implPart.replace(
      new RegExp(
        `(FUNCTION\\s+${escapeRe(className)}::)${escapeRe(oldName)}\\b`,
        "g"
      ),
      `$1${newName}`
    );

    return pre + newClassPart + newImplPart;
  });
}
