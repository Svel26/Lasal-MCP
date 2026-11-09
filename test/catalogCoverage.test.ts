import { describe, expect, it } from "vitest";
import { createPilotRegistry } from "../src/core/actions/pilotCatalog.js";
import { domainsForProfile } from "../src/core/actions/profiles.js";
import { findActionHandler } from "../src/core/actions/tools.js";
import type { ExecuteActionOptions } from "../src/core/actions/executor.js";
import type { ToolResponse } from "../src/utils/respond.js";

function body(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, unknown>;
}

const class2Options: ExecuteActionOptions = {
  domains: domainsForProfile("class2"),
  allowExpert: false,
  allowDestructive: true,
  audit: false,
};

const screenOptions: ExecuteActionOptions = {
  domains: domainsForProfile("screen"),
  allowExpert: false,
  allowDestructive: true,
  audit: false,
};

describe("catalog coverage", () => {
  it("registers all four domains and a substantial action catalog", () => {
    const registry = createPilotRegistry();
    expect(registry.size).toBeGreaterThanOrEqual(70);
    for (const domain of ["core", "class2", "visu", "screen", "lars"] as const) {
      expect(registry.list({ domains: [domain] }).length).toBeGreaterThan(0);
    }
  });

  it("filters CLASS 2 and SCREEN profiles at discovery time", async () => {
    const registry = createPilotRegistry();

    const class2 = body(await findActionHandler(registry, { query: "compile" }, class2Options));
    const class2Ids = (class2.actions as Array<{ id: string }>).map((action) => action.id);
    expect(class2Ids).toContain("class2.build.compile");
    expect(class2Ids).not.toContain("screen.project.compile");

    const screen = body(await findActionHandler(registry, { query: "compile" }, screenOptions));
    const screenIds = (screen.actions as Array<{ id: string }>).map((action) => action.id);
    expect(screenIds).toContain("screen.project.compile");
    expect(screenIds).not.toContain("class2.build.compile");
  });

  it("keeps destructive screen and LARS actions behind confirmation", () => {
    const registry = createPilotRegistry();
    for (const id of [
      "screen.project.download",
      "screen.editor.close",
      "lars.instance.stop",
      "lars.workspace.remove",
    ]) {
      const action = registry.get(id);
      expect(action, id).toBeDefined();
      expect(action?.destructive, id).toBe(true);
      expect(action?.requiresConfirm, id).toBe(true);
    }
  });

  it("exposes LARS actions in the LARS profile", async () => {
    const registry = createPilotRegistry();
    const response = body(
      await findActionHandler(
        registry,
        { query: "screenshot" },
        { domains: domainsForProfile("lars"), allowExpert: false, allowDestructive: true, audit: false },
      ),
    );
    const ids = (response.actions as Array<{ id: string }>).map((action) => action.id);
    expect(ids).toContain("lars.instance.screenshot");
  });

  it("includes the LARS config and scenario plus deploy actions", () => {
    const registry = createPilotRegistry();
    expect(registry.get("lars.workspace.update")?.risk).toBe("write");
    expect(registry.get("lars.scenario.run")?.asyncCapable).toBe(true);
    expect(registry.get("deploy.all.run")?.requiresConfirm).toBe(true);
    expect(registry.get("deploy.solution.run")?.requiresConfirm).toBe(true);
  });
});
