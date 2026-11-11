import { existsSync } from "fs";
import { z } from "zod";
import { getActiveAgents, setCurrentProject, setSharedProjectHint } from "../state.js";
import { findLsmPath } from "../utils/projectScanner.js";
import { resolveProjectContext } from "../core/project/context.js";

export const selectProjectSchema = {
  path: z.string().describe("Full path to the LASAL solution folder (must contain a .lsm file)."),
};

export async function selectProjectHandler(args: { path: string }) {
  const lsmPath = findLsmPath(args.path);
  if (!lsmPath || !existsSync(lsmPath)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: no .lsm file found in ${args.path}\nMake sure the path points to a valid LASAL solution folder.`,
        },
      ],
      isError: true,
    };
  }

  // Selection is per MCP server process: other agents keep their own project.
  setCurrentProject(args.path);
  setSharedProjectHint(args.path, { label: args.path.split(/[\\/]/).filter(Boolean).pop() });

  // Discover stations so the agent immediately knows available paths
  let summary: Record<string, unknown> = {
    selectedPath: args.path,
    scope: "this agent session only",
  };
  const context = resolveProjectContext(args.path);
  if (!("error" in context)) {
    summary = {
      ...summary,
      projectId: context.id,
      capabilities: context.capabilities,
      recommendedProfile: context.recommendedProfile,
      stations: context.stations.map((s) => ({
        name: s.name,
        ip: s.ip ?? null,
        port: s.port ?? "1954",
        ssltls: s.ssltls === "1",
        lcpPaths: s.lcpPaths,
        lvpPaths: s.lvpPaths,
      })),
      hint:
        context.stations.length > 1
          ? "Multiple stations found. Pass lcp_path or lvp_path explicitly to tools that need them."
          : "Single station found. Tools will auto-resolve lcp_path / lvp_path.",
    };
  } else {
    summary.hint = "Could not parse solution file for station discovery.";
  }

  const others = getActiveAgents().filter((a) => !a.isSelf);
  if (others.length > 0) {
    summary.otherAgents = others.map((a) => ({ pid: a.pid, project: a.project, since: a.since }));
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
  };
}
