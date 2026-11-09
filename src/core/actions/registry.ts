import { ActionExecutionError } from "./errors.js";
import type { AnyActionDefinition, Domain, Risk } from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

export interface ActionFilter {
  domains?: Domain[];
  risks?: Risk[];
  tags?: string[];
  includeExpert?: boolean;
}

/**
 * In-memory action registry. The registry is built once per server profile and
 * is intentionally side-effect free: constructing it never touches an engine.
 */
export class ActionRegistry {
  private readonly actions = new Map<string, AnyActionDefinition>();
  private readonly aliases = new Map<string, string>();

  constructor(actions: AnyActionDefinition[] = []) {
    for (const action of actions) this.register(action);
  }

  register(action: AnyActionDefinition): void {
    this.assertDefinition(action);

    const id = action.id.toLowerCase();
    if (this.actions.has(id)) {
      throw new Error(`Duplicate action id: ${action.id}`);
    }
    if (this.aliases.has(id)) {
      throw new Error(`Action id collides with an existing alias: ${action.id}`);
    }

    for (const alias of action.aliases) {
      const normalized = alias.toLowerCase();
      if (this.actions.has(normalized)) {
        throw new Error(`Alias '${alias}' of '${action.id}' collides with an action id`);
      }
      if (this.aliases.has(normalized)) {
        throw new Error(`Duplicate alias '${alias}' on '${action.id}'`);
      }
    }

    this.actions.set(id, action);
    for (const alias of action.aliases) this.aliases.set(alias.toLowerCase(), id);
  }

  get(idOrAlias: string): AnyActionDefinition | undefined {
    const key = idOrAlias.trim().toLowerCase();
    const canonical = this.aliases.get(key) ?? key;
    return this.actions.get(canonical);
  }

  resolve(idOrAlias: string): AnyActionDefinition {
    const action = this.get(idOrAlias);
    if (!action) {
      throw new ActionExecutionError("UNKNOWN_ACTION", `Unknown action: ${idOrAlias}`, {
        suggestions: this.list()
          .map((candidate) => candidate.id)
          .slice(0, 8),
      });
    }
    return action;
  }

  list(filter: ActionFilter = {}): AnyActionDefinition[] {
    const domains = filter.domains ? new Set(filter.domains) : null;
    const risks = filter.risks ? new Set(filter.risks) : null;
    const tags = filter.tags?.map((tag) => tag.toLowerCase());

    return [...this.actions.values()]
      .filter((action) => (domains ? domains.has(action.domain) : true))
      .filter((action) => (risks ? risks.has(action.risk) : true))
      .filter((action) => (filter.includeExpert ? true : !action.expert))
      .filter((action) => {
        if (!tags?.length) return true;
        const actionTags = action.tags.map((tag) => tag.toLowerCase());
        return tags.every((tag) => actionTags.includes(tag));
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.actions.size;
  }

  private assertDefinition(action: AnyActionDefinition): void {
    if (!ID_PATTERN.test(action.id)) {
      throw new Error(`Invalid action id '${action.id}': expected domain.resource.verb in lower-case`);
    }
    if (!action.summary.trim()) {
      throw new Error(`Action '${action.id}' has no summary`);
    }
    if (!action.schema || typeof action.schema.safeParse !== "function") {
      throw new Error(`Action '${action.id}' has no Zod schema`);
    }
    if (typeof action.handler !== "function") {
      throw new Error(`Action '${action.id}' has no handler`);
    }
    if (!Array.isArray(action.examples) || action.examples.length === 0) {
      throw new Error(`Action '${action.id}' needs at least one example`);
    }
    if (!["read", "write", "destructive", "deploy"].includes(action.risk)) {
      throw new Error(`Action '${action.id}' has invalid risk '${action.risk}'`);
    }
    if (action.requiresConfirm && action.risk !== "destructive" && action.risk !== "deploy") {
      throw new Error(`Action '${action.id}' requires confirmation but its risk is '${action.risk}'`);
    }
    if ((action.risk === "destructive" || action.risk === "deploy") && !action.requiresConfirm) {
      throw new Error(`Action '${action.id}' is ${action.risk} but does not require confirmation`);
    }

    for (const alias of action.aliases) {
      if (!ALIAS_PATTERN.test(alias)) {
        throw new Error(`Invalid alias '${alias}' on '${action.id}'`);
      }
      if (alias === action.id) {
        throw new Error(`Action '${action.id}' lists its own id as an alias`);
      }
    }

    for (const [index, example] of action.examples.entries()) {
      const parsed = action.schema.safeParse(example.params);
      if (!parsed.success) {
        throw new Error(`Example ${index + 1} of '${action.id}' does not match its schema: ${parsed.error.message}`);
      }
    }
  }
}
