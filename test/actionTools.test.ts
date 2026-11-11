import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionRegistry } from "../src/core/actions/registry.js";
import { executeActionHandler, findActionHandler } from "../src/core/actions/tools.js";
import { defineAction } from "../src/core/actions/types.js";
import type { ExecuteActionOptions } from "../src/core/actions/executor.js";
import type { ToolResponse } from "../src/utils/respond.js";

const options: ExecuteActionOptions = {
  domains: ["core"],
  allowExpert: false,
  allowDestructive: true,
  audit: false,
};

function registry(): ActionRegistry {
  return new ActionRegistry([
    defineAction({
      id: "test.echo",
      aliases: ["echo"],
      domain: "core",
      summary: "Echo a value.",
      schema: z.object({ value: z.string().optional() }),
      handler: async (params) => ({ ok: true, data: params }),
      risk: "read",
      destructive: false,
      requiresConfirm: false,
      requiresProject: false,
      tags: ["test", "echo"],
      examples: [{ params: { value: "hello" } }],
    }),
    defineAction({
      id: "test.destroy",
      aliases: ["destroy"],
      domain: "core",
      summary: "Destroy test data.",
      schema: z.object({}),
      handler: async () => ({ ok: true, data: "destroyed" }),
      risk: "destructive",
      destructive: true,
      requiresConfirm: true,
      requiresProject: false,
      tags: ["test", "destroy"],
      examples: [{ params: {} }],
    }),
    defineAction({
      id: "test.image",
      aliases: ["image"],
      domain: "core",
      summary: "Return an image content item.",
      schema: z.object({}),
      handler: async () => ({
        ok: true,
        data: { screenshot: true },
        images: [{ mimeType: "image/png", data: "AAAA" }],
      }),
      risk: "read",
      destructive: false,
      requiresConfirm: false,
      requiresProject: false,
      tags: ["test", "image"],
      examples: [{ params: {} }],
    }),
  ]);
}

function body(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("catalog MCP tools", () => {
  it("find returns schemas and examples", async () => {
    const response = await findActionHandler(registry(), { query: "echo" }, options);
    expect(response.isError).toBeUndefined();
    const parsed = body(response);
    expect(parsed.ok).toBe(true);
    const actions = parsed.actions as Array<Record<string, unknown>>;
    expect(actions[0]?.id).toBe("test.echo");
    expect(actions[0]?.schema).toBeDefined();
    expect(actions[0]?.examples).toEqual([{ action: "test.echo", params: { value: "hello" } }]);
  });

  it("find supports exact IDs and suggests unknown actions", async () => {
    const exact = await findActionHandler(registry(), { action: "test.echo" }, options);
    expect((body(exact).actions as Array<Record<string, unknown>>)[0]?.id).toBe("test.echo");

    const missing = await findActionHandler(registry(), { query: "nope" }, options);
    const parsed = body(missing);
    expect(parsed.ok).toBe(true);
    expect(parsed.actions).toEqual([]);
    expect(parsed.suggestions).toBeDefined();
  });

  it("find does not expose actions outside the profile", async () => {
    const response = await findActionHandler(registry(), { action: "test.destroy" }, { ...options, domains: ["visu"] });
    const parsed = body(response);
    expect(parsed.actions).toEqual([]);
    expect(parsed.hints).toEqual(
      expect.arrayContaining([expect.stringContaining("not available in this server profile")]),
    );
  });

  it("execute returns a success envelope", async () => {
    const response = await executeActionHandler(registry(), { action: "test.echo", params: { value: "hi" } }, options);
    expect(response.isError).toBeUndefined();
    const parsed = body(response);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual({ value: "hi" });
  });

  it("execute marks confirm-required failures as tool errors", async () => {
    const response = await executeActionHandler(registry(), { action: "test.destroy" }, options);
    expect(response.isError).toBe(true);
    const parsed = body(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("CONFIRM_REQUIRED");
  });

  it("execute passes through image content from legacy handlers", async () => {
    const response = await executeActionHandler(registry(), { action: "test.image" }, options);
    expect(response.isError).toBeUndefined();
    expect(response.content.some((entry) => entry.type === "image")).toBe(true);
  });
});
