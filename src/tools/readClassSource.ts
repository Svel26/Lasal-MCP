import { existsSync, readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { parseLcp, parseStClass } from "../utils/lasalXml.js";

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

export async function classSourceHandler(args: {
  action: "read" | "write";
  class_name: string;
  lcp_path?: string;
  include_header?: boolean;
  source?: string;
  header_source?: string;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) return { content: [{ type: "text" as const, text: resolved.error }], isError: true };

  const found = resolveStPath(resolved.path, args.class_name);
  if ("error" in found) {
    return { content: [{ type: "text" as const, text: found.error }], isError: true };
  }
  const { stPath } = found;

  if (args.action === "read") {
    const result: Record<string, unknown> = {
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // write
  if (!args.source) {
    return { content: [{ type: "text" as const, text: "source is required for action 'write'" }], isError: true };
  }

  const result: Record<string, unknown> = { className: args.class_name, stPath };
  try {
    writeFileSync(stPath, args.source, "latin1");
    result.stWritten = true;
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Failed to write .st file: ${e.message}` }], isError: true };
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

  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}
