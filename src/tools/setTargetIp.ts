import { existsSync } from "fs";
import { z } from "zod";
import { readState } from "../state.js";
import { findLsmPath, parseSolution, updateLssConnection } from "../utils/projectScanner.js";

export const setTargetIpSchema = {
  station: z
    .string()
    .optional()
    .describe(
      "Station name to update (e.g. 'PLC', 'HMI'). Omit if the project has only one station."
    ),
  ip: z
    .string()
    .optional()
    .describe("New IP address (e.g. '192.168.1.100')."),
  port: z
    .string()
    .optional()
    .describe("New port (default '1954'). Only change if non-standard."),
  ssltls: z
    .boolean()
    .optional()
    .describe("Enable SSL/TLS for the connection. Omit to leave unchanged."),
};

export async function setTargetIpHandler(args: {
  station?: string;
  ip?: string;
  port?: string;
  ssltls?: boolean;
}) {
  if (!args.ip && args.port === undefined && args.ssltls === undefined) {
    return {
      content: [{ type: "text" as const, text: "Error: specify at least one of ip, port, or ssltls to update." }],
      isError: true,
    };
  }

  const state = readState();
  if (!state.currentProject) {
    return {
      content: [{ type: "text" as const, text: "No project selected. Call select_project first." }],
      isError: true,
    };
  }

  const lsmPath = findLsmPath(state.currentProject);
  if (!lsmPath || !existsSync(lsmPath)) {
    return {
      content: [{ type: "text" as const, text: `No .lsm file found in ${state.currentProject}` }],
      isError: true,
    };
  }

  let solution;
  try {
    solution = parseSolution(lsmPath);
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to parse solution: ${e.message}` }],
      isError: true,
    };
  }

  if (solution.stations.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No stations found in solution." }],
      isError: true,
    };
  }

  let targetStation = solution.stations[0];
  if (!targetStation) {
    return {
      content: [{ type: "text" as const, text: "No stations found in solution." }],
      isError: true,
    };
  }

  if (args.station) {
    const match = solution.stations.find(
      (s) => s.name.toLowerCase() === args.station!.toLowerCase()
    );
    if (!match) {
      const names = solution.stations.map((s) => s.name).join(", ");
      return {
        content: [{ type: "text" as const, text: `Station "${args.station}" not found. Available: ${names}` }],
        isError: true,
      };
    }
    targetStation = match;
  } else if (solution.stations.length > 1) {
    const names = solution.stations.map((s) => `${s.name} (${s.ip ?? "no IP"})`).join(", ");
    return {
      content: [{
        type: "text" as const,
        text: `Multiple stations found — specify 'station':\n${names}`,
      }],
      isError: true,
    };
  }

  try {
    updateLssConnection(targetStation!.lssPath, {
      ip: args.ip,
      port: args.port,
      ssltls: args.ssltls !== undefined ? (args.ssltls ? "1" : "0") : undefined,
    });
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to update .lss: ${e.message}` }],
      isError: true,
    };
  }

  const updates: string[] = [];
  if (args.ip) updates.push(`IP → ${args.ip}`);
  if (args.port) updates.push(`PORT → ${args.port}`);
  if (args.ssltls !== undefined) updates.push(`SSLTLS → ${args.ssltls ? "1" : "0"}`);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ok: true,
        station: targetStation!.name,
        lssPath: targetStation!.lssPath,
        updated: updates,
      }, null, 2),
    }],
  };
}
