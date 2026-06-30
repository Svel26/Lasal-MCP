import { existsSync, writeFileSync } from "fs";
import { z } from "zod";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { parseLcp, parseStClass } from "../utils/lasalXml.js";

export const writeClassSourceSchema = {
  class_name: z
    .string()
    .describe("Name of the CLASS 2 class to write (e.g. 'Palletizer')."),
  source: z
    .string()
    .describe("Full content to write to the .st file. Must be latin1-compatible."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  header_source: z
    .string()
    .optional()
    .describe("Content to write to the .h file. Omit to leave the header unchanged."),
};

export async function writeClassSourceHandler(args: {
  class_name: string;
  source: string;
  lcp_path?: string;
  header_source?: string;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  let lcpInfo;
  try {
    lcpInfo = parseLcp(resolved.path);
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Failed to parse .lcp: ${e.message}` }], isError: true };
  }

  let stPath: string | null = null;
  for (const cf of lcpInfo.classFiles) {
    if (!cf.absPath.endsWith(".st") || !existsSync(cf.absPath)) continue;
    try {
      const info = parseStClass(cf.absPath);
      if (info.name === args.class_name) {
        stPath = cf.absPath;
        break;
      }
    } catch { /* skip */ }
  }

  if (!stPath) {
    const available = lcpInfo.classFiles
      .filter((f) => f.absPath.endsWith(".st") && existsSync(f.absPath))
      .map((f) => {
        try { return parseStClass(f.absPath).name; } catch { return null; }
      })
      .filter(Boolean);
    return {
      content: [{
        type: "text" as const,
        text: `Class "${args.class_name}" not found.\nAvailable classes: ${available.join(", ")}`,
      }],
      isError: true,
    };
  }

  const result: Record<string, unknown> = { className: args.class_name, stPath };

  try {
    writeFileSync(stPath, args.source, "latin1");
    result.stWritten = true;
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to write .st file: ${e.message}` }],
      isError: true,
    };
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

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
