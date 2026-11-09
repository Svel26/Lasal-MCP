import { startJob } from "../jobs.js";
import { runWithProject } from "../../state.js";
import { resolveProjectContext, canonicalProjectRoot, type ProjectContext } from "../project/context.js";
import { withProjectWriteLock } from "../project/locks.js";
import { respond } from "../../utils/respond.js";
import { auditParams, writeAudit } from "./audit.js";
import { ActionExecutionError, isActionExecutionError, zodFieldErrors } from "./errors.js";
import { actionJsonSchema } from "./schema.js";
import { suggestActions } from "./search.js";
import type { ActionRegistry } from "./registry.js";
import type {
  ActionContext,
  AnyActionDefinition,
  ActionEnvelope,
  ActionLogger,
  ActionResult,
  Domain,
} from "./types.js";

export interface ExecuteActionRequest {
  action: string;
  params?: Record<string, unknown>;
  confirm?: boolean;
  dry_run?: boolean;
  async?: boolean;
  project?: string;
}

export interface ExecuteActionOptions {
  domains: Domain[];
  allowExpert?: boolean;
  allowDestructive?: boolean;
  pinnedProject?: string | null;
  audit?: boolean;
}

function createLogger(actionId: string): ActionLogger {
  const write = (level: string, message: string, extra?: Record<string, unknown>) => {
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    process.stderr.write(`[lasal:${actionId}] ${level}: ${message}${suffix}\n`);
  };
  return {
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}

function projectEnvelope(project: ProjectContext | null): { id: string; root: string } | undefined {
  return project ? { id: project.id, root: project.root } : undefined;
}

function errorEnvelope(error: ActionExecutionError, action?: string, project?: ProjectContext | null): ActionEnvelope {
  return {
    ok: false,
    ...(action ? { action } : {}),
    ...(project ? { project: projectEnvelope(project) } : {}),
    code: error.code,
    error: error.message,
    ...(error.details.fieldErrors ? { fieldErrors: error.details.fieldErrors } : {}),
    ...(error.details.schema !== undefined ? { schema: error.details.schema } : {}),
    ...(error.details.example !== undefined ? { example: error.details.example } : {}),
    ...(error.details.suggestions ? { suggestions: error.details.suggestions } : {}),
    ...(error.details.hints ? { hints: error.details.hints } : {}),
  };
}

function resultEnvelope(
  action: AnyActionDefinition,
  project: ProjectContext | null,
  result: ActionResult,
): ActionEnvelope {
  if (!result.ok) {
    return {
      ok: false,
      action: action.id,
      ...(project ? { project: projectEnvelope(project) } : {}),
      code: result.error?.code ?? "ACTION_FAILED",
      error: result.error?.message ?? "Action failed without a message.",
      ...(result.error?.fieldErrors ? { fieldErrors: result.error.fieldErrors } : {}),
      ...(result.error?.schema !== undefined ? { schema: result.error.schema } : {}),
      ...(result.error?.example !== undefined ? { example: result.error.example } : {}),
      ...(result.error?.suggestions ? { suggestions: result.error.suggestions } : {}),
      ...(result.error?.hints ? { hints: result.error.hints } : {}),
      ...(result.data !== undefined ? { result: result.data } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.hints ? { hints: result.hints } : {}),
      ...(result.images ? { images: result.images } : {}),
    };
  }

  return {
    ok: true,
    action: action.id,
    ...(project ? { project: projectEnvelope(project) } : {}),
    result: result.data,
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.hints ? { hints: result.hints } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.images ? { images: result.images } : {}),
    ...(result.nextSteps ? { nextSteps: result.nextSteps } : {}),
  };
}

function projectPathFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  for (const key of ["project_dir", "lsm_path", "lcp_path", "lvp_path", "lpr_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function resolveProjectForAction(
  action: AnyActionDefinition,
  request: ExecuteActionRequest,
  options: ExecuteActionOptions,
  params: unknown,
): ProjectContext | null {
  const pinned = options.pinnedProject ? resolveProjectContext(options.pinnedProject) : null;
  if (pinned && "error" in pinned) {
    throw new ActionExecutionError("PROJECT_NOT_FOUND", pinned.error);
  }

  let explicit: ProjectContext | null = null;
  if (request.project) {
    const resolved = resolveProjectContext(request.project);
    if ("error" in resolved) {
      throw new ActionExecutionError("PROJECT_NOT_FOUND", resolved.error);
    }
    explicit = resolved;
  }

  const pathRef = projectPathFromParams(params);
  let pathContext: ProjectContext | null = null;
  if (pathRef) {
    const resolved = resolveProjectContext(pathRef);
    if (!("error" in resolved)) pathContext = resolved;
  }

  if (pinned) {
    for (const candidate of [explicit, pathContext]) {
      if (candidate && candidate.root !== canonicalProjectRoot(pinned.root)) {
        throw new ActionExecutionError(
          "PROJECT_PINNED",
          `This server is pinned to '${pinned.root}' and cannot execute against '${candidate.root}'.`,
          { hints: ["Use a server without --project, or pass --allow-project-override."] },
        );
      }
    }
  }

  const current =
    pinned ??
    (() => {
      const resolved = resolveProjectContext();
      return "error" in resolved ? null : resolved;
    })();

  const project = explicit ?? pathContext ?? current;
  if (action.requiresProject && !project) {
    throw new ActionExecutionError("PROJECT_REQUIRED", `Action '${action.id}' requires a project.`, {
      hints: ["Call select_project first, pass project, or pass an action path such as lcp_path/lvp_path/lpr_path."],
    });
  }

  return project;
}

/**
 * Execute one catalog action.
 *
 * This is the only place that enforces profile availability, expert gating,
 * confirmation, parameter validation, project pinning and auditing.
 */
export async function executeAction(
  registry: ActionRegistry,
  request: ExecuteActionRequest,
  options: ExecuteActionOptions,
): Promise<ActionEnvelope> {
  const startedAt = Date.now();
  let action: AnyActionDefinition | undefined;
  let project: ProjectContext | null = null;
  const audit = options.audit !== false;

  try {
    action = registry.get(request.action);
    if (!action) {
      throw new ActionExecutionError("UNKNOWN_ACTION", `Unknown action: ${request.action}`, {
        suggestions: suggestActions(registry, request.action),
        hints: ["Call lasal_find_action to search the catalog."],
      });
    }

    if (!options.domains.includes(action.domain)) {
      throw new ActionExecutionError(
        "ACTION_NOT_AVAILABLE",
        `Action '${action.id}' is not available in this server profile.`,
        { hints: [`Available domains: ${options.domains.join(", ")}`] },
      );
    }

    if (action.expert && !options.allowExpert) {
      throw new ActionExecutionError(
        "ACTION_NOT_AVAILABLE",
        `Action '${action.id}' is an expert action and is disabled.`,
        { hints: ["Start the server with --allow-expert to enable it."] },
      );
    }

    if ((action.risk === "destructive" || action.risk === "deploy") && options.allowDestructive === false) {
      throw new ActionExecutionError(
        "DESTRUCTIVE_DISABLED",
        `Action '${action.id}' is ${action.risk} and destructive actions are disabled.`,
        { hints: ["Start the server with --allow-destructive to enable it."] },
      );
    }

    if (action.requiresConfirm && request.confirm !== true) {
      throw new ActionExecutionError("CONFIRM_REQUIRED", `Action '${action.id}' requires explicit confirmation.`, {
        hints: ["Set top-level confirm=true on lasal_execute_action (not inside params)."],
        example: { action: action.id, params: request.params ?? {}, confirm: true },
      });
    }

    if (request.dry_run && action.dryRunSupported !== true) {
      throw new ActionExecutionError("DRY_RUN_UNSUPPORTED", `Action '${action.id}' does not support dry_run.`);
    }

    if (request.async && action.asyncCapable !== true) {
      throw new ActionExecutionError("ASYNC_UNSUPPORTED", `Action '${action.id}' does not support async execution.`);
    }

    const parsed = action.schema.safeParse(request.params ?? {});
    if (!parsed.success) {
      throw new ActionExecutionError("INVALID_PARAMS", `Invalid params for '${action.id}'.`, {
        fieldErrors: zodFieldErrors(parsed.error),
        ...(actionJsonSchema(action) !== undefined ? { schema: actionJsonSchema(action) } : {}),
        ...(action.examples[0] ? { example: { action: action.id, params: action.examples[0].params } } : {}),
      });
    }

    project = resolveProjectForAction(action, request, options, parsed.data);

    const ctx: ActionContext = {
      project,
      projectId: project?.id ?? null,
      agentPid: process.pid,
      confirm: request.confirm === true,
      dryRun: request.dry_run === true,
      async: request.async === true,
      logger: createLogger(action.id),
    };

    const params = parsed.data;
    const run = async (): Promise<ActionEnvelope> => {
      const execute = async (): Promise<ActionEnvelope> => {
        try {
          const result = await runWithProject(project?.root ?? null, () => action!.handler(params, ctx));
          return resultEnvelope(action!, project, result);
        } catch (error) {
          if (isActionExecutionError(error)) {
            return errorEnvelope(error, action!.id, project);
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            action: action!.id,
            ...(project ? { project: projectEnvelope(project) } : {}),
            code: "ACTION_FAILED",
            error: message,
          };
        }
      };

      if (project && action!.risk !== "read") {
        return withProjectWriteLock(project.id, action!.id, execute);
      }
      return execute();
    };

    if (audit) {
      writeAudit({
        event: "action.start",
        action: action.id,
        project: project?.id,
        projectRoot: project?.root,
        params: auditParams(params),
        confirm: request.confirm === true,
        dryRun: request.dry_run === true,
        async: request.async === true,
      });
    }

    if (request.async === true) {
      const job = startJob(action.id, () => run().then((envelope) => respond(envelope)));
      const envelope: ActionEnvelope = {
        ok: true,
        action: action.id,
        ...(project ? { project: projectEnvelope(project) } : {}),
        jobId: job.id,
        result: { status: "pending", jobId: job.id },
        nextSteps: ["Poll check_job_status with this jobId until status is completed or failed."],
      };
      if (audit) {
        writeAudit({
          event: "action.async",
          action: action.id,
          jobId: job.id,
          project: project?.id,
          durationMs: Date.now() - startedAt,
        });
      }
      return envelope;
    }

    const envelope = await run();
    if (audit) {
      writeAudit({
        event: "action.finish",
        action: action.id,
        ok: envelope.ok,
        code: envelope.code,
        project: project?.id,
        durationMs: Date.now() - startedAt,
      });
    }
    return envelope;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = isActionExecutionError(error)
      ? error
      : /Timed out after .* waiting for lock/i.test(message)
        ? new ActionExecutionError("ENGINE_BUSY", message, {
            hints: ["Another agent is editing this project or the engine is busy. Retry after it finishes."],
          })
        : new ActionExecutionError("ACTION_FAILED", message);
    if (audit) {
      writeAudit({
        event: "action.finish",
        action: action?.id ?? request.action,
        ok: false,
        code: normalized.code,
        project: project?.id,
        durationMs: Date.now() - startedAt,
      });
    }
    return errorEnvelope(normalized, action?.id, project);
  }
}
