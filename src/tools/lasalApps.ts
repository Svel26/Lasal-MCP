import { spawn } from "child_process";
import { existsSync } from "fs";
import { z } from "zod";
import { readState } from "../state.js";
import { findLcpFiles, findLvpFiles } from "../utils/projectScanner.js";
import { CLASS2_EXE, VISUDESIGNER_EXE, killClass2, killVisuDesigner } from "../utils/engine.js";

function requireProject(): { path: string } | { error: string } {
  const state = readState();
  if (!state.currentProject) {
    return { error: "No project selected. Call select_project first." };
  }
  return { path: state.currentProject };
}

function launchDetached(exe: string, args: string[]): void {
  const child = spawn(exe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}



// --- manage_visudesigner ---

export const manageVisuDesignerSchema = {
  action: z.enum(["open", "close"]).describe("'open' launches VISUDesigner; 'close' kills it."),
  lvp_path: z
    .string()
    .optional()
    .describe(
      "Full path to the .lvp station file to open (open only). Omit to auto-detect from the selected project."
    ),
};

export async function manageVisuDesignerHandler(args: { action: "open" | "close"; lvp_path?: string }) {
  if (args.action === "close") {
    killVisuDesigner();
    return { content: [{ type: "text" as const, text: "VISUDesigner closed." }] };
  }

  const proj = requireProject();
  if ("error" in proj) {
    return { content: [{ type: "text" as const, text: proj.error }], isError: true };
  }

  const lvpPath = args.lvp_path;

  if (!lvpPath) {
    const found = findLvpFiles(proj.path);
    if (found.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No .lvp files found in ${proj.path}` }],
        isError: true,
      };
    }
    if (found.length === 1 && found[0]) {
      launchDetached(VISUDESIGNER_EXE, [found[0]]);
      return { content: [{ type: "text" as const, text: `VISUDesigner opened with: ${found[0]}` }] };
    }
    return {
      content: [{
        type: "text" as const,
        text: ["Multiple .lvp stations found. Specify lvp_path with one of:", ...found.map((f) => `  ${f}`)].join("\n"),
      }],
    };
  }

  if (!existsSync(lvpPath)) {
    return { content: [{ type: "text" as const, text: `File not found: ${lvpPath}` }], isError: true };
  }

  launchDetached(VISUDESIGNER_EXE, [lvpPath]);
  return { content: [{ type: "text" as const, text: `VISUDesigner opened with: ${lvpPath}` }] };
}

// --- manage_class2 ---

export const manageClass2Schema = {
  action: z.enum(["open", "close"]).describe("'open' launches LASAL CLASS 2; 'close' kills it."),
  lcp_path: z
    .string()
    .optional()
    .describe(
      "Full path to the .lcp station file to open (open only). Omit to auto-detect from the selected project."
    ),
};

export async function manageClass2Handler(args: { action: "open" | "close"; lcp_path?: string }) {
  if (args.action === "close") {
    killClass2();
    return { content: [{ type: "text" as const, text: "CLASS 2 closed." }] };
  }

  const proj = requireProject();
  if ("error" in proj) {
    return { content: [{ type: "text" as const, text: proj.error }], isError: true };
  }

  const lcpPath = args.lcp_path;

  if (!lcpPath) {
    const found = findLcpFiles(proj.path);
    if (found.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No .lcp files found in ${proj.path}` }],
        isError: true,
      };
    }
    if (found.length === 1 && found[0]) {
      launchDetached(CLASS2_EXE, [found[0]]);
      return { content: [{ type: "text" as const, text: `CLASS 2 opened with: ${found[0]}` }] };
    }
    return {
      content: [{
        type: "text" as const,
        text: ["Multiple .lcp stations found. Specify lcp_path with one of:", ...found.map((f) => `  ${f}`)].join("\n"),
      }],
    };
  }

  if (!existsSync(lcpPath)) {
    return { content: [{ type: "text" as const, text: `File not found: ${lcpPath}` }], isError: true };
  }

  launchDetached(CLASS2_EXE, [lcpPath]);
  return { content: [{ type: "text" as const, text: `CLASS 2 opened with: ${lcpPath}` }] };
}
