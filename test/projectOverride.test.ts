import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getCurrentProject, readState, runWithProject, setCurrentProject, updateState } from "../src/state.js";

describe("request-scoped project override", () => {
  let stateDir: string;
  const projectA = "C:\\projects\\alpha";
  const projectB = "C:\\projects\\beta";
  const projectC = "C:\\projects\\gamma";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lasal-mcp-override-"));
    process.env.LASAL_MCP_STATE_FILE = join(stateDir, "lasal-state.json");
    setCurrentProject(projectA);
  });

  afterEach(() => {
    setCurrentProject(null);
    delete process.env.LASAL_MCP_STATE_FILE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("overrides getCurrentProject only inside the async context", () => {
    expect(getCurrentProject()).toBe(projectA);
    expect(runWithProject(projectB, () => getCurrentProject())).toBe(projectB);
    expect(getCurrentProject()).toBe(projectA);
  });

  it("propagates the override through readState and updateState", () => {
    runWithProject(projectB, () => {
      expect(readState().currentProject).toBe(projectB);
      const observed = updateState((state) => state.currentProject);
      expect(observed).toBe(projectB);
    });

    expect(readState().currentProject).toBe(projectA);
  });

  it("propagates through promises and nested overrides", async () => {
    const observed = await runWithProject(projectB, async () => {
      await Promise.resolve();
      const outer = getCurrentProject();
      const inner = runWithProject(projectC, () => getCurrentProject());
      return { outer, inner, after: getCurrentProject() };
    });

    expect(observed).toEqual({ outer: projectB, inner: projectC, after: projectB });
    expect(getCurrentProject()).toBe(projectA);
  });

  it("can explicitly clear the override for one context", () => {
    expect(runWithProject(null, () => getCurrentProject())).toBeNull();
    expect(getCurrentProject()).toBe(projectA);
  });
});
