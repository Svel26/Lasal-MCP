import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { z } from "zod";
import { ActionRegistry } from "../src/core/actions/registry.js";
import { executeAction, type ExecuteActionOptions } from "../src/core/actions/executor.js";
import { canonicalProjectRoot } from "../src/core/project/context.js";
import { defineAction } from "../src/core/actions/types.js";
import { getJob } from "../src/core/jobs.js";
import { setCurrentProject, writeState } from "../src/state.js";

function makeRegistry(): ActionRegistry {
  const base = {
    domain: "core" as const,
    destructive: false,
    requiresConfirm: false,
    requiresProject: false,
    tags: ["test"],
  };

  return new ActionRegistry([
    defineAction({
      ...base,
      id: "test.echo",
      aliases: ["echo"],
      summary: "Echo.",
      schema: z.object({ value: z.string().optional() }),
      handler: async (params, ctx) => ({ ok: true, data: { params, project: ctx.project?.root ?? null } }),
      risk: "read",
      examples: [{ params: {} }],
    }),
    defineAction({
      ...base,
      id: "test.validation",
      aliases: ["validation"],
      summary: "Requires a value.",
      schema: z.object({ value: z.string() }),
      handler: async (params) => ({ ok: true, data: params }),
      risk: "read",
      examples: [{ params: { value: "ok" } }],
    }),
    defineAction({
      ...base,
      id: "test.write",
      aliases: ["write"],
      summary: "Project-scoped write.",
      schema: z.object({}),
      handler: async (_params, ctx) => ({ ok: true, data: { project: ctx.project?.root ?? null } }),
      risk: "write",
      requiresProject: true,
      examples: [{ params: {} }],
    }),
    defineAction({
      ...base,
      id: "test.pathwrite",
      aliases: ["pathwrite"],
      summary: "Project-scoped write resolved from a path param.",
      schema: z.object({ lcp_path: z.string().optional() }),
      handler: async (_params, ctx) => ({ ok: true, data: { project: ctx.project?.root ?? null } }),
      risk: "write",
      requiresProject: true,
      examples: [{ params: {} }],
    }),
    defineAction({
      ...base,
      id: "test.destroy",
      aliases: ["destroy"],
      summary: "Destructive test action.",
      schema: z.object({}),
      handler: async () => ({ ok: true, data: "destroyed" }),
      risk: "destructive",
      destructive: true,
      requiresConfirm: true,
      examples: [{ params: {} }],
    }),
    defineAction({
      ...base,
      id: "test.async",
      aliases: ["async"],
      summary: "Async test action.",
      schema: z.object({}),
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true, data: "async-done" };
      },
      risk: "read",
      asyncCapable: true,
      examples: [{ params: {} }],
    }),
    defineAction({
      ...base,
      id: "test.expert",
      aliases: ["expert"],
      summary: "Expert test action.",
      schema: z.object({}),
      handler: async () => ({ ok: true, data: "expert-done" }),
      risk: "read",
      expert: true,
      examples: [{ params: {} }],
    }),
    defineAction({
      ...base,
      id: "test.visu",
      aliases: ["visu_test"],
      summary: "VISU test action.",
      domain: "visu",
      schema: z.object({}),
      handler: async () => ({ ok: true, data: "visu-done" }),
      risk: "read",
      examples: [{ params: {} }],
    }),
  ]);
}

describe("executeAction", () => {
  let stateDir: string;
  let auditDir: string;
  let projectA: string;
  let projectB: string;
  let registry: ActionRegistry;

  const baseOptions: ExecuteActionOptions = {
    domains: ["core", "visu"],
    allowExpert: false,
    allowDestructive: true,
    audit: false,
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lasal-mcp-actions-state-"));
    auditDir = mkdtempSync(join(tmpdir(), "lasal-mcp-actions-audit-"));
    projectA = mkdtempSync(join(tmpdir(), "lasal-mcp-project-a-"));
    projectB = mkdtempSync(join(tmpdir(), "lasal-mcp-project-b-"));
    process.env.LASAL_MCP_STATE_FILE = join(stateDir, "lasal-state.json");
    process.env.LASAL_MCP_AUDIT_FILE = join(auditDir, "audit.jsonl");
    process.env.LASAL_MCP_LOCK_DIR = join(stateDir, "locks");
    setCurrentProject(null);
    writeState({ currentProject: null });
    registry = makeRegistry();
  });

  afterEach(() => {
    setCurrentProject(null);
    delete process.env.LASAL_MCP_STATE_FILE;
    delete process.env.LASAL_MCP_AUDIT_FILE;
    delete process.env.LASAL_MCP_LOCK_DIR;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("rejects unknown actions with suggestions", async () => {
    const envelope = await executeAction(registry, { action: "does.not.exist" }, baseOptions);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNKNOWN_ACTION");
    expect(envelope.suggestions).toBeDefined();
  });

  it("validates params and returns field errors plus an example", async () => {
    const envelope = await executeAction(registry, { action: "test.validation", params: {} }, baseOptions);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INVALID_PARAMS");
    expect(envelope.fieldErrors?.[0]?.path).toBe("value");
    expect(envelope.schema).toBeDefined();
    expect(envelope.example).toBeDefined();
  });

  it("requires confirmation for destructive actions", async () => {
    const without = await executeAction(registry, { action: "test.destroy" }, baseOptions);
    expect(without.ok).toBe(false);
    expect(without.code).toBe("CONFIRM_REQUIRED");

    const withConfirm = await executeAction(registry, { action: "test.destroy", confirm: true }, baseOptions);
    expect(withConfirm.ok).toBe(true);
    expect(withConfirm.result).toBe("destroyed");
  });

  it("enforces the profile domain boundary", async () => {
    const envelope = await executeAction(registry, { action: "test.visu" }, { ...baseOptions, domains: ["core"] });
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("ACTION_NOT_AVAILABLE");
  });

  it("gates expert actions", async () => {
    const disabled = await executeAction(registry, { action: "test.expert" }, baseOptions);
    expect(disabled.ok).toBe(false);
    expect(disabled.code).toBe("ACTION_NOT_AVAILABLE");

    const enabled = await executeAction(registry, { action: "test.expert" }, { ...baseOptions, allowExpert: true });
    expect(enabled.ok).toBe(true);
  });

  it("can disable destructive actions entirely", async () => {
    const envelope = await executeAction(
      registry,
      { action: "test.destroy", confirm: true },
      { ...baseOptions, allowDestructive: false },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("DESTRUCTIVE_DISABLED");
  });

  it("requires a project for project-scoped actions", async () => {
    const envelope = await executeAction(registry, { action: "test.write" }, baseOptions);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("PROJECT_REQUIRED");
  });

  it("runs project-scoped actions in the selected project context", async () => {
    setCurrentProject(projectA);
    const envelope = await executeAction(registry, { action: "test.write" }, baseOptions);
    expect(envelope.ok).toBe(true);
    expect(envelope.project?.root).toBe(canonicalProjectRoot(projectA));
    expect((envelope.result as { project: string }).project).toBe(canonicalProjectRoot(projectA));
  });

  it("supports an explicit project override without changing the process selection", async () => {
    setCurrentProject(projectA);
    const envelope = await executeAction(registry, { action: "test.write", project: projectB }, baseOptions);
    expect(envelope.ok).toBe(true);
    expect(envelope.project?.root).toBe(canonicalProjectRoot(projectB));
    expect((envelope.result as { project: string }).project).toBe(canonicalProjectRoot(projectB));

    const current = await executeAction(registry, { action: "test.write" }, baseOptions);
    expect(current.project?.root).toBe(canonicalProjectRoot(projectA));
  });

  it("derives the project context from an action path parameter", async () => {
    writeFileSync(join(projectA, "PLC.lcp"), "");
    const envelope = await executeAction(
      registry,
      { action: "test.pathwrite", params: { lcp_path: join(projectA, "PLC.lcp") } },
      baseOptions,
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.project?.root).toBe(canonicalProjectRoot(projectA));
  });

  it("enforces a pinned project", async () => {
    const envelope = await executeAction(
      registry,
      { action: "test.write", project: projectB },
      { ...baseOptions, pinnedProject: projectA },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("PROJECT_PINNED");
  });

  it("rejects a missing explicit project", async () => {
    const envelope = await executeAction(
      registry,
      { action: "test.write", project: join(projectA, "missing") },
      baseOptions,
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("PROJECT_NOT_FOUND");
  });

  it("runs async actions as background jobs", async () => {
    const envelope = await executeAction(registry, { action: "test.async", async: true }, baseOptions);
    expect(envelope.ok).toBe(true);
    expect(envelope.jobId).toBeTruthy();

    for (let i = 0; i < 100; i += 1) {
      const job = getJob(envelope.jobId!);
      if (job && job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const job = getJob(envelope.jobId!);
    expect(job?.status).toBe("completed");
    const content = (job?.result as { content?: Array<{ text: string }> } | undefined)?.content;
    expect(content?.[0]?.text).toContain('"ok": true');
  });

  it("rejects async and dry-run requests for unsupported actions", async () => {
    const asyncEnvelope = await executeAction(registry, { action: "test.echo", async: true }, baseOptions);
    expect(asyncEnvelope.ok).toBe(false);
    expect(asyncEnvelope.code).toBe("ASYNC_UNSUPPORTED");

    const dryRunEnvelope = await executeAction(registry, { action: "test.echo", dry_run: true }, baseOptions);
    expect(dryRunEnvelope.ok).toBe(false);
    expect(dryRunEnvelope.code).toBe("DRY_RUN_UNSUPPORTED");
  });
});
