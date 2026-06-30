import { existsSync } from "fs";
import { join, basename } from "path";
import { readState } from "../state.js";
import { findLcpFiles, findLvpFiles } from "./projectScanner.js";

export function resolveLcpPath(lcpPath?: string): { path: string } | { error: string } {
  if (lcpPath) {
    if (!existsSync(lcpPath)) return { error: `File not found: ${lcpPath}` };
    return { path: lcpPath };
  }
  const state = readState();
  if (!state.currentProject) return { error: "No project selected. Call select_project first." };

  // Legacy flat layout: {dir}/{name}.lcp
  const name = basename(state.currentProject);
  const direct = join(state.currentProject, `${name}.lcp`);
  if (existsSync(direct)) return { path: direct };

  // Multi-station layout: search via .lsm → .lss
  const found = findLcpFiles(state.currentProject);
  if (found.length === 0) return { error: `No .lcp files found in ${state.currentProject}` };
  if (found.length === 1) return { path: found[0] };
  return {
    error:
      `Multiple .lcp stations found — specify lcp_path:\n` +
      found.map((f) => `  ${f}`).join("\n"),
  };
}

export function resolveLvpPath(lvpPath?: string): { path: string } | { error: string } {
  if (lvpPath) {
    if (!existsSync(lvpPath)) return { error: `File not found: ${lvpPath}` };
    return { path: lvpPath };
  }
  const state = readState();
  if (!state.currentProject) return { error: "No project selected. Call select_project first." };

  const found = findLvpFiles(state.currentProject);
  if (found.length === 0) return { error: `No .lvp files found in ${state.currentProject}` };
  if (found.length === 1) return { path: found[0] };
  return {
    error:
      `Multiple .lvp stations found — specify lvp_path:\n` +
      found.map((f) => `  ${f}`).join("\n"),
  };
}
