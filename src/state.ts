import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const STATE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lasal-state.json"
);

interface LasalState {
  currentProject: string | null;
  topDirectory: string;
}

const DEFAULT_STATE: LasalState = {
  currentProject: null,
  topDirectory: "C:\\_Projects",
};

export function readState(): LasalState {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(state: LasalState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}
