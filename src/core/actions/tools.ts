import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { respond, type ToolResponse } from "../../utils/respond.js";
import { executeAction, type ExecuteActionOptions } from "./executor.js";
import type { ActionRegistry } from "./registry.js";
import { actionExamples, actionJsonSchema } from "./schema.js";
import { searchActions } from "./search.js";
import type { AnyActionDefinition, Domain, Risk } from "./types.js";

const domainSchema = z.enum(["core", "class2", "visu", "screen", "lars", "deploy"]);
const riskSchema = z.enum(["read", "write", "destructive", "deploy"]);

export const findActionSchema = {
  query: z
    .string()
    .optional()
    .describe("Natural-language search, e.g. 'export visu text lists' or 'start lars workspace'."),
  action: z
    .string()
    .optional()
    .describe(
      "Exact canonical action ID or alias. When supplied, returns the full schema and examples for that action.",
    ),
  domain: domainSchema.optional().describe("Restrict results to one domain."),
  tags: z.array(z.string()).optional().describe("Require all supplied tags, e.g. ['visu', 'textlist']."),
  risk: z.array(riskSchema).optional().describe("Restrict results to one or more risk tiers."),
  include_expert: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include expert actions such as class2.script.run. Default false."),
  limit: z.number().int().min(1).max(20).optional().default(5).describe("Maximum number of results. Default 5."),
  include_schema: z
    .enum(["none", "summary", "full"])
    .optional()
    .describe("Schema detail: 'none' hides schemas, 'summary' returns it for the top result, 'full' for all results."),
};

export const executeActionSchema = {
  action: z.string().describe("Canonical action ID or alias returned by lasal_find_action."),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe("Action-specific parameters object. Use {} for actions with no parameters."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Set top-level confirm=true to approve a destructive or deploy action. Do not put confirm inside params.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe("Preview the action without changing anything when supported."),
  async: z.boolean().optional().default(false).describe("Run as a background job and poll with check_job_status."),
  project: z
    .string()
    .optional()
    .describe("Project path or project ID. Omit to use the process-pinned or selected project."),
};

export interface FindActionArgs {
  query?: string;
  action?: string;
  domain?: Domain;
  tags?: string[];
  risk?: Risk[];
  include_expert?: boolean;
  limit?: number;
  include_schema?: "none" | "summary" | "full";
}

export interface ExecuteActionArgs {
  action: string;
  params?: Record<string, unknown>;
  confirm?: boolean;
  dry_run?: boolean;
  async?: boolean;
  project?: string;
}

function summarizeAction(action: AnyActionDefinition, includeSchema: boolean): Record<string, unknown> {
  const schema = includeSchema ? actionJsonSchema(action) : undefined;
  return {
    id: action.id,
    aliases: action.aliases,
    domain: action.domain,
    summary: action.summary,
    ...(action.description ? { description: action.description } : {}),
    risk: action.risk,
    destructive: action.destructive,
    requiresConfirm: action.requiresConfirm,
    requiresProject: action.requiresProject,
    dryRunSupported: action.dryRunSupported === true,
    asyncCapable: action.asyncCapable === true,
    ...(action.expert ? { expert: true } : {}),
    tags: action.tags,
    ...(schema !== undefined ? { schema } : {}),
    examples: actionExamples(action),
    ...(action.hints ? { hints: action.hints } : {}),
    ...(action.deprecated ? { deprecated: action.deprecated } : {}),
  };
}

export async function findActionHandler(
  registry: ActionRegistry,
  args: FindActionArgs,
  options: ExecuteActionOptions,
): Promise<ToolResponse> {
  const query = args.query?.trim();
  const requested = args.action ? registry.get(args.action) : undefined;
  const requestedAvailable =
    requested &&
    options.domains.includes(requested.domain) &&
    (!requested.expert || (args.include_expert ?? options.allowExpert ?? false));
  const exact = requestedAvailable ? requested : undefined;
  const unavailableHint =
    requested && !requestedAvailable
      ? `Action '${requested.id}' exists but is not available in this server profile.`
      : undefined;

  const hits = (
    exact
      ? [{ action: exact, score: 1000 }]
      : searchActions(registry, {
          query: query ?? args.action,
          ...(args.domain ? { domain: args.domain } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.risk ? { risk: args.risk } : {}),
          includeExpert: args.include_expert ?? options.allowExpert ?? false,
          limit: args.limit ?? 5,
        })
  ).filter((hit) => options.domains.includes(hit.action.domain));

  const includeSchema = args.include_schema ?? (exact ? "full" : "summary");
  const actions = hits.map((hit, index) =>
    summarizeAction(hit.action, includeSchema === "full" || (includeSchema === "summary" && index === 0)),
  );

  const suggestions =
    actions.length === 0
      ? searchActions(registry, {
          query: query ?? args.action ?? "",
          includeExpert: args.include_expert ?? options.allowExpert ?? false,
          limit: 20,
        })
          .filter((hit) => options.domains.includes(hit.action.domain))
          .slice(0, 5)
          .map((hit) => hit.action.id)
      : [];
  const hints = [
    ...(unavailableHint ? [unavailableHint] : []),
    ...(actions.length === 0
      ? ["No action matched. Try a broader query, remove filters, or use include_expert=true."]
      : []),
  ];

  return respond({
    ok: true,
    actions,
    total: actions.length,
    ...(query ? { query } : {}),
    ...(actions.length === 0 ? { suggestions } : {}),
    ...(hints.length ? { hints } : {}),
  });
}

export async function executeActionHandler(
  registry: ActionRegistry,
  args: ExecuteActionArgs,
  options: ExecuteActionOptions,
): Promise<ToolResponse> {
  const envelope = await executeAction(
    registry,
    {
      action: args.action,
      params: args.params ?? {},
      confirm: args.confirm,
      dry_run: args.dry_run,
      async: args.async,
      project: args.project,
    },
    options,
  );

  const { images, ...body } = envelope;
  const response = respond(body);
  if (images?.length) {
    response.content.push(
      ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
    );
  }
  return response;
}

/**
 * Register the two catalog tools on a server. Profiles differ only by the
 * registry and the domains allowed in `options`.
 */
export function registerCatalogTools(server: McpServer, registry: ActionRegistry, options: ExecuteActionOptions): void {
  server.tool(
    "lasal_find_action",
    "Search the local LASAL action catalog. Read-only and makes no engine or PLC call. " +
      "Use when the action ID or params are unclear. Returns JSON Schemas, hints, destructive flags, and execute examples.",
    findActionSchema,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (args) => findActionHandler(registry, args as FindActionArgs, options),
  );

  server.tool(
    "lasal_execute_action",
    "Execute one LASAL catalog action by canonical ID or alias. Always pass params as an object. " +
      "Destructive actions require top-level confirm=true. Use lasal_find_action first only when the action or params are unclear.",
    executeActionSchema,
    { destructiveHint: true, openWorldHint: true },
    async (args) => executeActionHandler(registry, args as ExecuteActionArgs, options),
  );
}
