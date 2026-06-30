import { existsSync } from "fs";
import { z } from "zod";
import {
  parseLcp,
  parseStClass,
  parseLcn,
  LcpInfo,
  StClassInfo,
  LcnInfo,
} from "../utils/lasalXml.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";

export const inspectProjectSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
  class_names: z
    .array(z.string())
    .optional()
    .describe(
      "Return full channel details only for these class names. Omit to get a summary of all classes (name + channel counts). " +
      "Use this to drill into specific classes after the initial summary."
    ),
  include_networks: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include network objects in the output. Default false to keep output small."),
  include_connections: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include network connections in the output (requires include_networks). Default false."),
};

export async function inspectProjectHandler(args: {
  lcp_path?: string;
  class_names?: string[];
  include_networks?: boolean;
  include_connections?: boolean;
}) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  let lcpInfo: LcpInfo;
  try {
    lcpInfo = parseLcp(resolved.path);
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to parse .lcp: ${e.message}` }],
      isError: true,
    };
  }

  const filterNames = args.class_names ? new Set(args.class_names) : null;

  // Parse class definitions
  const classErrors: string[] = [];
  const parsedClasses: Array<StClassInfo & { stPath: string; hPath: string }> = [];

  for (const cf of lcpInfo.classFiles) {
    if (!cf.absPath.endsWith(".st") || !existsSync(cf.absPath)) continue;
    try {
      const info = parseStClass(cf.absPath);
      if (filterNames && !filterNames.has(info.name)) continue;
      const hPath = cf.absPath.replace(/\.st$/, ".h");
      parsedClasses.push({ ...info, stPath: cf.absPath, hPath });
    } catch (e: any) {
      classErrors.push(`${cf.relativePath}: ${e.message}`);
    }
  }

  // Build class output: summary (no filter) vs full detail (with filter)
  let classesOutput: unknown[];
  if (filterNames) {
    // Full detail for requested classes
    classesOutput = parsedClasses.map((c) => ({
      name: c.name,
      revision: c.revision,
      stPath: c.stPath,
      hPath: c.hPath,
      taskTypes: { cyclic: c.cyclicTask, realtime: c.realtimeTask, background: c.backgroundTask },
      servers: c.servers.map((s) => ({
        name: s.name,
        visualized: s.visualized,
        initialize: s.initialize,
        defValue: s.defValue,
        writeProtected: s.writeProtected,
        retentive: s.retentive,
        ...(s.comment ? { comment: s.comment } : {}),
      })),
      clients: c.clients.map((cl) => ({
        name: cl.name,
        required: cl.required,
        internal: cl.internal,
        ...(cl.comment ? { comment: cl.comment } : {}),
      })),
    }));
  } else {
    // Summary only — parse all but return just names + counts (avoids giant output)
    const allClasses: Array<{ name: string; revision?: string; servers: number; clients: number }> = [];
    for (const cf of lcpInfo.classFiles) {
      if (!cf.absPath.endsWith(".st") || !existsSync(cf.absPath)) continue;
      try {
        const info = parseStClass(cf.absPath);
        allClasses.push({
          name: info.name,
          revision: info.revision,
          servers: info.servers.length,
          clients: info.clients.length,
        });
      } catch { /* skip */ }
    }
    classesOutput = allClasses;
  }

  const result: Record<string, unknown> = {
    projectName: lcpInfo.projectName,
    lcpPath: lcpInfo.lcpPath,
    projectDir: lcpInfo.projectDir,
    totalClasses: lcpInfo.classFiles.filter((f) => f.absPath.endsWith(".st")).length,
    totalNetworks: lcpInfo.networkFiles.length,
    ...(filterNames
      ? { classDetail: classesOutput }
      : { classSummary: classesOutput }),
  };

  // Networks (optional)
  if (args.include_networks) {
    const networks: Array<LcnInfo> = [];
    const networkErrors: string[] = [];
    for (const nf of lcpInfo.networkFiles) {
      if (!existsSync(nf.absPath)) continue;
      try { networks.push(parseLcn(nf.absPath)); } catch (e: any) {
        networkErrors.push(`${nf.relativePath}: ${e.message}`);
      }
    }
    result.networks = networks.map((n) => ({
      name: n.name,
      lcnPath: n.lcnPath,
      objects: n.objects.map((o) => ({
        name: o.name,
        className: o.className,
        ...(Object.keys(o.channelValues).length ? { channelValues: o.channelValues } : {}),
      })),
      ...(args.include_connections
        ? { connections: n.connections.map((c) => ({
            source: c.source,
            destination: c.destination,
            ...(c.remote ? { remote: true, station: c.station } : {}),
          })) }
        : {}),
    }));
    if (networkErrors.length) result.networkParseErrors = networkErrors;
  }

  if (classErrors.length) result.classParseErrors = classErrors;

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
