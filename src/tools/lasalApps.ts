import { spawn } from "child_process";
import { existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { z } from "zod";
import { readState } from "../state.js";
import { findLvpFiles } from "../utils/projectScanner.js";

const VISUDESIGNER_EXE =
  "C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe";
const CLASS2_EXE =
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

export const openClass2Schema = {};

export async function openClass2Handler(_args: Record<string, never>) {
  const proj = requireProject();
  if ("error" in proj) {
    return { content: [{ type: "text" as const, text: proj.error }], isError: true };
  }

  const projectName = basename(proj.path);
  const lsmPath = join(proj.path, `${projectName}.lsm`);

  if (!existsSync(lsmPath)) {
    return {
      content: [{ type: "text" as const, text: `Project .lsm not found: ${lsmPath}` }],
      isError: true,
    };
  }

  launchDetached(CLASS2_EXE, [lsmPath]);
  return {
    content: [{ type: "text" as const, text: `CLASS 2 opened with: ${lsmPath}` }],
  };
}

// --- close_class2 ---

export const closeClass2Schema = {};

export async function closeClass2Handler(_args: Record<string, never>) {
  const result = killByName("Lasal2.exe");
  return { content: [{ type: "text" as const, text: result }] };
}
