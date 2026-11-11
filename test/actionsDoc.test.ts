import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { actionsDocPath, renderActionsDoc } from "../src/scripts/generateActionsDoc.js";
import { createPilotRegistry } from "../src/core/actions/pilotCatalog.js";

describe("generated action reference", () => {
  it("matches the current registry", () => {
    const rendered = renderActionsDoc();
    const current = readFileSync(actionsDocPath(), "utf-8").replace(/\r\n/g, "\n");
    expect(current).toBe(rendered);
  });

  it("lists every action", () => {
    const rendered = renderActionsDoc();
    for (const action of createPilotRegistry().list({ includeExpert: true })) {
      expect(rendered).toContain(`### \`${action.id}\``);
    }
  });
});
