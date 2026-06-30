import { existsSync } from "fs";
import { z } from "zod";
import { readState, writeState } from "../state.js";
import { findLsmPath, parseSolution } from "../utils/projectScanner.js";

export const selectProjectSchema = {
  path: z
    .string()
    .describe("Full path to the LASAL solution folder (must contain a .lsm file)."),
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

  const state = readState();
  state.currentProject = args.path;
  writeState(state);

  // Discover stations so the agent immediately knows available paths
  let summary: Record<string, unknown> = { selectedPath: args.path };
  try {
    const solution = parseSolution(lsmPath);
    summary.stations = solution.stations.map((s) => ({
      name: s.name,
      ip: s.ip ?? null,
      port: s.port ?? "1954",
      ssltls: s.ssltls === "1",
      lcpPaths: s.lcpPaths,
      lvpPaths: s.lvpPaths,
    }));
    summary.hint =
      solution.stations.length > 1
        ? "Multiple stations found. Pass lcp_path or lvp_path explicitly to tools that need them."
        : "Single station found. Tools will auto-resolve lcp_path / lvp_path.";
  } catch {
    summary.hint = "Could not parse solution file for station discovery.";
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
  };
}
