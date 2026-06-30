import { spawn } from "child_process";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { z } from "zod";
import { readState } from "../state.js";
import { findLcpFiles, findLvpFiles } from "../utils/projectScanner.js";

const VISUDESIGNER_EXE =
  process.env.LASAL_VISUDESIGNER_EXE ||
  "C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe";
const CLASS2_EXE =
  process.env.LASAL_CLASS2_EXE ||
  "C:\\Program Files (x86)\\Sigmatek\\Lasal\\Class2\\Bin\\Lasal2.exe";

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

function killByName(processName: string): string {
  try {
    execSync(`taskkill /IM "${processName}" /F`, { stdio: "pipe" });
    return `${processName} closed.`;
  } catch {
    return `${processName} was not running.`;
  }
}



// --- open_visudesigner ---

export const openVisuDesignerSchema = {
  lvp_path: z
    .string()
    .optional()
    .describe(
      "Full path to the .lvp station file to open. Omit to auto-detect from the selected project (required only when multiple .lvp files exist)."
    ),
};

export async function openVisuDesignerHandler(args: { lvp_path?: string }) {
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
    if (found.length === 1) {
      launchDetached(VISUDESIGNER_EXE, [found[0]]);
      return {
        content: [{ type: "text" as const, text: `VISUDesigner opened with: ${found[0]}` }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Multiple .lvp stations found. Specify lvp_path with one of:",
            ...found.map((f) => `  ${f}`),
          ].join("\n"),
        },
      ],
    };
  }

  if (!existsSync(lvpPath)) {
    return {
      content: [{ type: "text" as const, text: `File not found: ${lvpPath}` }],
      isError: true,
    };
  }

  launchDetached(VISUDESIGNER_EXE, [lvpPath]);
  return {
    content: [{ type: "text" as const, text: `VISUDesigner opened with: ${lvpPath}` }],
  };
}

// --- close_visudesigner ---

export const closeVisuDesignerSchema = {};

export async function closeVisuDesignerHandler(_args: Record<string, never>) {
  const result = killByName("VISUDesigner.exe");
  return { content: [{ type: "text" as const, text: result }] };
}

// --- open_class2 ---

export const openClass2Schema = {
  lcp_path: z
    .string()
    .optional()
    .describe(
      "Full path to the .lcp station file to open. Omit to auto-detect from the selected project (required only when multiple .lcp files exist)."
    ),
};

export async function openClass2Handler(args: { lcp_path?: string }) {
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
    if (found.length === 1) {
      launchDetached(CLASS2_EXE, [found[0]]);
      return {
        content: [{ type: "text" as const, text: `CLASS 2 opened with: ${found[0]}` }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Multiple .lcp stations found. Specify lcp_path with one of:",
            ...found.map((f) => `  ${f}`),
          ].join("\n"),
        },
      ],
    };
  }

  if (!existsSync(lcpPath)) {
    return {
      content: [{ type: "text" as const, text: `File not found: ${lcpPath}` }],
      isError: true,
    };
  }

  launchDetached(CLASS2_EXE, [lcpPath]);
  return {
    content: [{ type: "text" as const, text: `CLASS 2 opened with: ${lcpPath}` }],
  };
}

// --- close_class2 ---

export const closeClass2Schema = {};

export async function closeClass2Handler(_args: Record<string, never>) {
  const result = killByName("Lasal2.exe");
  return { content: [{ type: "text" as const, text: result }] };
}
