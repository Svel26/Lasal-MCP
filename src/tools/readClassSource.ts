import { existsSync, readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { parseLcp, parseStClass } from "../utils/lasalXml.js";
import { isProcessRunning } from "../utils/engine.js";
import { respond, fail } from "../utils/respond.js";

export const classSourceSchema = {
  action: z.enum(["read", "write"]).describe("'read' returns the source; 'write' overwrites it."),
  class_name: z.string().describe("Name of the CLASS 2 class (e.g. 'Palletizer')."),
  lcp_path: z.string().optional().describe("Absolute path to the .lcp file. Omit to use the selected project."),
  include_header: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also return the .h file contents (read only). Default false."),
  source: z
    .string()
    .optional()
    .describe("Full content to write to the .st file — must be latin1-compatible (write only)."),
  header_source: z
    .string()
    .optional()
    .describe("Content to write to the .h file. Omit to leave it unchanged (write only)."),
};

function resolveStPath(
  lcpPath: string,
  className: string
): { stPath: string } | { error: string } {
  let lcpInfo;
  try {
    lcpInfo = parseLcp(lcpPath);
  } catch (e: any) {
    return { error: `Failed to parse .lcp: ${e.message}` };
  }

  for (const cf of lcpInfo.classFiles) {
    if (!cf.absPath.endsWith(".st") || !existsSync(cf.absPath)) continue;
    try {
      const info = parseStClass(cf.absPath);
      if (info.name === className) return { stPath: cf.absPath };
    } catch { /* skip */ }
  }

  const available = lcpInfo.classFiles
    .filter((f) => f.absPath.endsWith(".st") && existsSync(f.absPath))
    .map((f) => { try { return parseStClass(f.absPath).name; } catch { return null; } })
    .filter(Boolean);
  return { error: `Class "${className}" not found.\nAvailable classes: ${available.join(", ")}` };
}

function validateLatin1(s: string): { ok: boolean; offending?: { char: string; code: number; index: number }[] } {
  const offending: { char: string; code: number; index: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) {
      offending.push({ char: s[i], code, index: i });
      if (offending.length >= 10) break;
    }
  }
  return {
    ok: offending.length === 0,
    offending: offending.length > 0 ? offending : undefined
  };
}

export async function classSourceHandler(args: {
  action: "read" | "write";
  class_name: string;
  lcp_path?: string;
  include_header?: boolean;
  source?: string;
  header_source?: string;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
  }

  const found = resolveStPath(resolved.path, args.class_name);
  if ("error" in found) {
    return fail(found.error, ["Make sure the class name is typed correctly."]);
  }
  const { stPath } = found;

  if (args.action === "read") {
    const result: any = {
      ok: true,
      className: args.class_name,
      stPath,
      source: readFileSync(stPath, "latin1"),
    };
    if (args.include_header) {
      const hPath = stPath.replace(/\.st$/, ".h");
      if (existsSync(hPath)) {
        result.hPath = hPath;
        result.headerSource = readFileSync(hPath, "latin1");
      }
    }
    return respond(result);
  }

  // write
  if (isProcessRunning("Lasal2.exe")) {
    return fail(
      "CLASS 2 IDE is open.",
      ["Close the CLASS 2 IDE manually or run manage_class2 close before writing to Structured Text class files."]
    );
  }

  if (!args.source) {
    return fail("source is required for action 'write'", ["Provide the source parameter."]);
  }

  // Validate latin1
  const validation = validateLatin1(args.source);
  if (!validation.ok) {
    const details = validation.offending!.map(o => `'${o.char}' (code: ${o.code}) at index ${o.index}`).join(", ");
    return fail(
      "Source contains non-latin1 characters.",
      ["Make sure all characters in the source are representable in ISO-8859-1 (latin1). Offending characters: " + details]
    );
  }

  if (args.header_source !== undefined) {
    const hValidation = validateLatin1(args.header_source);
    if (!hValidation.ok) {
      const details = hValidation.offending!.map(o => `'${o.char}' (code: ${o.code}) at index ${o.index}`).join(", ");
      return fail(
        "Header source contains non-latin1 characters.",
        ["Make sure all characters in the header source are representable in ISO-8859-1 (latin1). Offending characters: " + details]
      );
    }
  }

  const result = { ok: true, className: args.class_name, stPath } as any;
  try {
    writeFileSync(stPath, args.source, "latin1");
    result.stWritten = true;
  } catch (e: any) {
    return fail(`Failed to write .st file: ${e.message}`, []);
  }

  if (args.header_source !== undefined) {
    const hPath = stPath.replace(/\.st$/, ".h");
    try {
      writeFileSync(hPath, args.header_source, "latin1");
      result.hPath = hPath;
      result.hWritten = true;
    } catch (e: any) {
      result.hError = `Failed to write .h file: ${e.message}`;
    }
  }

  return respond(result);
}
