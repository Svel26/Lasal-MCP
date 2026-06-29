import { existsSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";
import { readState, writeState } from "../state.js";

export const selectProjectSchema = {
  path: z
    .string()
    .describe("Full path to the LASAL project folder (must contain a matching .lsm file)."),
};

export async function selectProjectHandler(args: { path: string }) {
  const lsm = join(args.path, `${basename(args.path)}.lsm`);
  if (!existsSync(lsm)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: no matching .lsm file found at ${lsm}\nMake sure the path points to a valid LASAL project folder.`,
        },
      ],
      isError: true,
    };
  }
  const state = readState();
  state.currentProject = args.path;
  writeState(state);
  return {
    content: [
      { type: "text" as const, text: `Active project set to: ${args.path}` },
    ],
  };
}
