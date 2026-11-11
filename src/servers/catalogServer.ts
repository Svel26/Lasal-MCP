import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPilotRegistry } from "../core/actions/pilotCatalog.js";
import { domainsForProfile, isProfile, type Profile } from "../core/actions/profiles.js";
import { registerCatalogTools } from "../core/actions/tools.js";
import { resolveProjectContext } from "../core/project/context.js";
import { registerResources } from "../resources/registerResources.js";
import { setCurrentProject } from "../state.js";
import { checkJobStatusHandler, checkJobStatusSchema } from "../tools/checkJobStatus.js";
import { selectProjectHandler, selectProjectSchema } from "../tools/selectProject.js";
import { lasalStatusHandler, lasalStatusSchema } from "../tools/status.js";
import { cleanupScratch } from "../utils/engine.js";

const CATALOG_GUIDE = `# LASAL Action Catalog

This server exposes a small core plus a local action catalog:

- \`lasal_find_action\` — search action IDs, schemas, examples and risk flags. No engine call.
- \`lasal_execute_action\` — run one action. Pass action-specific values in \`params\`.
- \`select_project\`, \`lasal_status\`, \`check_job_status\` — session and job control.

## Rules

1. Use \`lasal_find_action\` only when the action ID or params are unclear.
2. Destructive and deploy actions require top-level \`confirm=true\`.
3. Long-running actions may support \`async: true\`; poll with \`check_job_status\`.
4. Project files are latin1 unless documented otherwise. Prefer actions over raw file edits for structural project changes.

The catalog contains CLASS 2, VISUDesigner, LASAL SCREEN, LARS and shared project actions. Each server profile exposes only its own domains.
`;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

/**
 * Start a catalog server for one default profile. Each domain bin calls this
 * with its own profile; `--profile` can still override it for advanced use.
 */
export async function startCatalogServer(defaultProfile: Profile | "auto"): Promise<void> {
  const requestedProfile = argValue("--profile") ?? process.env.LASAL_MCP_PROFILE ?? defaultProfile;
  const pinnedProject = argValue("--project") ?? process.env.LASAL_MCP_PROJECT?.trim() ?? undefined;

  let profile: Profile;
  if (requestedProfile === "auto") {
    if (!pinnedProject) {
      process.stderr.write("--profile auto requires --project <path> or LASAL_MCP_PROJECT.\n");
      process.exit(2);
    }
    const context = resolveProjectContext(pinnedProject);
    if ("error" in context) {
      process.stderr.write(`Cannot auto-detect profile: ${context.error}\n`);
      process.exit(2);
    }
    profile = context.recommendedProfile;
    process.stderr.write(
      `Detected profile '${profile}' (class2=${context.capabilities.class2}, visu=${context.capabilities.visu}, ` +
        `screen=${context.capabilities.screen}).\n`,
    );
  } else if (isProfile(requestedProfile)) {
    profile = requestedProfile;
  } else {
    process.stderr.write(
      `Unknown profile '${requestedProfile}'. Expected: auto, class2, visu, screen, lars, solution.\n`,
    );
    process.exit(2);
  }

  if (pinnedProject) setCurrentProject(pinnedProject);

  const allowExpert = process.argv.includes("--allow-expert");
  const allowDestructive = process.argv.includes("--allow-destructive");

  const registry = createPilotRegistry();
  const server = new McpServer({
    name: `lasal-${profile}-mcp`,
    version: "0.4.0-preview",
  });

  server.tool(
    "select_project",
    "Set the active LASAL project for THIS agent session by directory path. Call first — all other tools default to this project.",
    selectProjectSchema,
    { idempotentHint: true, openWorldHint: false },
    selectProjectHandler,
  );

  server.tool(
    "lasal_status",
    "Check project selection, station discovery, PLC/HMI reachability, engine paths, running processes, HMI runtime health, live agent sessions and CLASS 2 ownership.",
    lasalStatusSchema,
    { readOnlyHint: true, idempotentHint: true },
    lasalStatusHandler,
  );

  server.tool(
    "check_job_status",
    "Poll the status of a background job started with async: true. Omit jobId to list recent jobs.",
    checkJobStatusSchema,
    { readOnlyHint: true, idempotentHint: true },
    checkJobStatusHandler,
  );

  registerCatalogTools(server, registry, {
    domains: domainsForProfile(profile),
    allowExpert,
    allowDestructive,
    ...(pinnedProject ? { pinnedProject } : {}),
    audit: true,
  });

  registerResources(server, CATALOG_GUIDE);
  cleanupScratch();

  process.stderr.write(
    `lasal ${profile} MCP (catalog preview): ${registry.size} actions, ` +
      `destructive=${allowDestructive ? "enabled" : "disabled"}, expert=${allowExpert ? "enabled" : "disabled"}` +
      `${pinnedProject ? `, project=${pinnedProject}` : ""}\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
