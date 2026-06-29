import { existsSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";
import { readState } from "../state.js";
import {
  parseLcp,
  parseStClass,
  parseLcn,
  LcpInfo,
  StClassInfo,
  LcnInfo,
} from "../utils/lasalXml.js";

export const inspectProjectSchema = {
  lcp_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to the .lcp file. Omit to use the currently selected project."
    ),
  include_connections: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include network connections in the output (default true)."),
};

function resolveLcpPath(lcpPath?: string): { path: string } | { error: string } {
  if (lcpPath) {
    if (!existsSync(lcpPath)) return { error: `File not found: ${lcpPath}` };
    return { path: lcpPath };
  }
  const state = readState();
  if (!state.currentProject) return { error: "No project selected. Call select_project first." };
  const name = basename(state.currentProject);
  const lcp = join(state.currentProject, `${name}.lcp`);
  if (!existsSync(lcp)) return { error: `No .lcp found at ${lcp}` };
  return { path: lcp };
}

export async function inspectProjectHandler(args: {
  lcp_path?: string;
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

  // Parse class definitions
  const classes: Array<StClassInfo & { stPath: string; hPath: string }> = [];
  const classErrors: string[] = [];

  for (const cf of lcpInfo.classFiles) {
    if (!cf.absPath.endsWith(".st") || !existsSync(cf.absPath)) continue;
    try {
      const info = parseStClass(cf.absPath);
      // derive .h path (same folder, same name)
      const hPath = cf.absPath.replace(/\.st$/, ".h");
      classes.push({ ...info, stPath: cf.absPath, hPath });
    } catch (e: any) {
      classErrors.push(`${cf.relativePath}: ${e.message}`);
    }
  }

  // Parse networks
  const networks: Array<LcnInfo> = [];
  const networkErrors: string[] = [];

  for (const nf of lcpInfo.networkFiles) {
    if (!existsSync(nf.absPath)) continue;
    try {
      networks.push(parseLcn(nf.absPath));
    } catch (e: any) {
      networkErrors.push(`${nf.relativePath}: ${e.message}`);
    }
  }

  const result: Record<string, unknown> = {
    projectName: lcpInfo.projectName,
    lcpPath: lcpInfo.lcpPath,
    projectDir: lcpInfo.projectDir,
    classes: classes.map((c) => ({
      name: c.name,
      revision: c.revision,
      stPath: c.stPath,
      hPath: c.hPath,
      taskTypes: {
        cyclic: c.cyclicTask,
        realtime: c.realtimeTask,
        background: c.backgroundTask,
      },
      servers: c.servers.map((s) => ({
        name: s.name,
        visualized: s.visualized,
        initialize: s.initialize,
        defValue: s.defValue,
        writeProtected: s.writeProtected,
        retentive: s.retentive,
        comment: s.comment,
      })),
      clients: c.clients.map((cl) => ({
        name: cl.name,
        required: cl.required,
        internal: cl.internal,
        comment: cl.comment,
      })),
    })),
    networks: networks.map((n) => ({
      name: n.name,
      lcnPath: n.lcnPath,
      objects: n.objects.map((o) => ({
        name: o.name,
        className: o.className,
        position: o.position,
        channelValues: o.channelValues,
      })),
      ...(args.include_connections !== false
        ? {
            connections: n.connections.map((c) => ({
              source: c.source,
              destination: c.destination,
              ...(c.remote ? { remote: true, station: c.station } : {}),
            })),
          }
        : {}),
    })),
  };

  if (classErrors.length) result.classParseErrors = classErrors;
  if (networkErrors.length) result.networkParseErrors = networkErrors;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
