import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionRegistry } from "../src/core/actions/registry.js";
import { actionExamples, actionJsonSchema } from "../src/core/actions/schema.js";
import { searchActions, suggestActions } from "../src/core/actions/search.js";
import { defineAction, type ActionContext, type ActionDefinition } from "../src/core/actions/types.js";

const ctx: ActionContext = {
  project: null,
  projectId: null,
  agentPid: process.pid,
  confirm: false,
  dryRun: false,
  async: false,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

function echoAction(): ActionDefinition<{ value: string }> {
  return defineAction({
    id: "test.echo",
    aliases: ["echo", "say"],
    domain: "core",
    summary: "Echo a value back.",
    description: "Test-only action used by the catalog unit tests.",
    schema: z.object({ value: z.string() }),
    handler: async (params) => ({ ok: true, data: params }),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["test", "echo"],
    examples: [{ params: { value: "hello" } }],
  });
}

function visuAction(): ActionDefinition<{ lvp_path?: string }> {
  return defineAction({
    id: "visu.project.inspect",
    aliases: ["inspect_visu"],
    domain: "visu",
    summary: "Inspect a VISU project.",
    schema: z.object({ lvp_path: z.string().optional() }),
    handler: async () => ({ ok: true, data: { inspected: true } }),
    risk: "read",
    destructive: false,
    requiresConfirm: false,
    requiresProject: true,
    tags: ["visu", "inspect"],
    examples: [{ params: {} }],
  });
}

describe("ActionRegistry", () => {
  it("registers actions and resolves canonical IDs and aliases", () => {
    const registry = new ActionRegistry([echoAction(), visuAction()]);
    expect(registry.get("test.echo")?.id).toBe("test.echo");
    expect(registry.get("ECHO")?.id).toBe("test.echo");
    expect(registry.get("say")?.id).toBe("test.echo");
    expect(registry.get("visu.project.inspect")?.id).toBe("visu.project.inspect");
    expect(registry.get("inspect_visu")?.id).toBe("visu.project.inspect");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  it("rejects duplicate IDs and aliases", () => {
    const registry = new ActionRegistry([echoAction()]);
    const duplicateId = { ...echoAction(), aliases: [] };
    expect(() => registry.register(duplicateId)).toThrow(/Duplicate action id/);

    const duplicateAlias = defineAction({
      ...echoAction(),
      id: "test.other",
      aliases: ["echo"],
    });
    expect(() => registry.register(duplicateAlias)).toThrow(/Duplicate alias/);
  });

  it("rejects invalid examples and destructive actions without confirmation", () => {
    const invalidExample = defineAction({
      ...echoAction(),
      examples: [{ params: {} }],
    });
    expect(() => new ActionRegistry([invalidExample])).toThrow(/does not match its schema/);

    const destructiveWithoutConfirm = defineAction({
      ...echoAction(),
      id: "test.destroy",
      aliases: ["destroy"],
      risk: "destructive",
      destructive: true,
      requiresConfirm: false,
    });
    expect(() => new ActionRegistry([destructiveWithoutConfirm])).toThrow(/does not require confirmation/);
  });

  it("generates JSON Schema and execute examples", () => {
    const action = echoAction();
    const schema = actionJsonSchema(action) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties?.value).toBeTruthy();
    expect(schema.required).toContain("value");
    expect(actionExamples(action)).toEqual([{ action: "test.echo", params: { value: "hello" } }]);
  });
});

describe("action search", () => {
  it("ranks exact IDs and aliases first", () => {
    const registry = new ActionRegistry([echoAction(), visuAction()]);
    const exact = searchActions(registry, { query: "test.echo", limit: 5 });
    expect(exact[0]?.action.id).toBe("test.echo");
    expect(exact[0]?.score).toBe(1000);

    const alias = searchActions(registry, { query: "say", limit: 5 });
    expect(alias[0]?.action.id).toBe("test.echo");
    expect(alias[0]?.score).toBe(900);
  });

  it("searches summaries and tags", () => {
    const registry = new ActionRegistry([echoAction(), visuAction()]);
    const bySummary = searchActions(registry, { query: "inspect", limit: 5 });
    expect(bySummary[0]?.action.id).toBe("visu.project.inspect");

    const byTag = searchActions(registry, { query: "echo", tags: ["test"], limit: 5 });
    expect(byTag[0]?.action.id).toBe("test.echo");
  });

  it("filters by domain and risk", () => {
    const registry = new ActionRegistry([echoAction(), visuAction()]);
    expect(searchActions(registry, { domain: "visu" }).map((hit) => hit.action.id)).toEqual(["visu.project.inspect"]);
    expect(searchActions(registry, { risk: ["read"] }).map((hit) => hit.action.id)).toEqual([
      "test.echo",
      "visu.project.inspect",
    ]);
  });

  it("suggests close matches for typos", () => {
    const registry = new ActionRegistry([echoAction()]);
    expect(suggestActions(registry, "ehco", 3)).toContain("test.echo");
  });

  it("hides expert actions unless requested", () => {
    const expert = defineAction({
      ...echoAction(),
      id: "test.expert",
      aliases: ["expert"],
      expert: true,
    });
    const registry = new ActionRegistry([expert]);
    expect(searchActions(registry, { query: "expert" })).toHaveLength(0);
    expect(searchActions(registry, { query: "expert", includeExpert: true })[0]?.action.id).toBe("test.expert");
  });
});

describe("action context", () => {
  it("has the fields handlers need", () => {
    expect(ctx.agentPid).toBe(process.pid);
    expect(ctx.confirm).toBe(false);
  });
});
