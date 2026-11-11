import { z } from "zod";
import { fromToolResponse } from "../../core/actions/legacy.js";
import { defineAction } from "../../core/actions/types.js";
import { deployAllHandler, deployAllSchema } from "../../tools/deployAll.js";
import { deploySolutionHandler, deploySolutionSchema } from "../../tools/deploySolution.js";

const deployAllParams = z.object(deployAllSchema).omit({ async: true });
const deploySolutionParams = z.object(deploySolutionSchema).omit({ async: true });

export const deployActions = [
  defineAction({
    id: "deploy.all.run",
    aliases: ["deploy_all", "deploy_solution_all"],
    domain: "deploy",
    summary:
      "Full single-solution deploy: compile, download PLC, start PLC, compile/download SCREEN, sync/download VISU, start HMI.",
    schema: deployAllParams,
    handler: async (params) => fromToolResponse(await deployAllHandler({ ...params, async: false })),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["deploy", "pipeline", "class2", "visu", "screen", "plc", "hmi"],
    examples: [
      {
        params: { compile: false, download_plc: true, start_plc: true },
        note: "Download and start an already compiled PLC project.",
      },
    ],
    hints: ["Each step is optional via flags. Use async=true for long deployments."],
  }),

  defineAction({
    id: "deploy.solution.run",
    aliases: ["deploy_solution", "machinemanager_deploy"],
    domain: "deploy",
    summary: "Multi-station deploy through MachineManager using a generated .lutc update file.",
    description:
      "Generates a .lutc from the solution and executes it with MachineManager.exe /update. " +
      "The official flow for pushing CLASS 2 + LASAL SCREEN + VISUDesigner to a panel.",
    schema: deploySolutionParams,
    handler: async (params) => fromToolResponse(await deploySolutionHandler({ ...params, async: false })),
    risk: "deploy",
    destructive: true,
    requiresConfirm: true,
    requiresProject: true,
    asyncCapable: true,
    tags: ["deploy", "machinemanager", "lutc", "multi-station", "solution"],
    examples: [
      {
        params: {
          stations: [{ station: "PLC", class2: true }],
          dry_run: true,
        },
        note: "Generate a .lutc for review without executing MachineManager.",
      },
    ],
    hints: ["Use params.dry_run=true first to inspect the generated .lutc."],
  }),
];
