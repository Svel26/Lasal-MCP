import { z } from "zod";
import { fromToolResponse } from "../../core/actions/legacy.js";
import { defineAction } from "../../core/actions/types.js";
import { setTargetIpHandler } from "../../tools/setTargetIp.js";

export const projectActions = [
  defineAction({
    id: "project.target_ip.set",
    aliases: ["set_target_ip", "set_target", "target_ip", "set_ip"],
    domain: "core",
    summary: "Update a station's target IP, port or SSL setting in its .lss and LSE online config.",
    description:
      "Performs a surgical edit of the station .lss connection and keeps any LASAL SCREEN LSEOnlineConfig.xml sidecar in sync. Other settings are preserved.",
    schema: z.object({
      station: z
        .string()
        .optional()
        .describe("Station name, e.g. 'PLC' or 'HMI'. Omit when the solution has one station."),
      ip: z.string().optional().describe("New IP address, e.g. '192.168.1.100'."),
      port: z.string().optional().describe("New port. Default is unchanged; use '1954' for the standard online port."),
      ssltls: z.boolean().optional().describe("Enable or disable SSL/TLS. Omit to leave unchanged."),
    }),
    handler: async (params) => fromToolResponse(await setTargetIpHandler(params)),
    risk: "write",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    idempotent: true,
    tags: ["station", "target", "network", "ip", "lss"],
    examples: [
      { params: { station: "PLC", ip: "192.168.1.100" }, note: "Point the PLC station at a new controller." },
      { params: { station: "HMI", ssltls: true }, note: "Enable TLS for the HMI connection." },
    ],
    hints: ["Specify at least one of ip, port or ssltls."],
  }),
];
