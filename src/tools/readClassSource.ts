import { existsSync, readFileSync } from "fs";
import { z } from "zod";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { parseLcp, parseStClass } from "../utils/lasalXml.js";

export const readClassSourceSchema = {
  class_name: z
    .string()
    .describe("Name of the CLASS 2 class to read (e.g. 'Palletizer')."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the selected project."),
  include_header: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also return the contents of the .h file (interface header). Default false."),
};

export async function readClassSourceHandler(args: {
  class_name: string;
  lcp_path?: string;
  include_header?: boolean;
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

  // Find the .st file for the requested class
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

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
