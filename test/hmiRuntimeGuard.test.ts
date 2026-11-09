import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setCurrentProject, writeState } from "../src/state.js";
import { startHmiRuntime } from "../src/tools/hmiRuntime.js";

describe("HMI runtime project guard", () => {
  let stateDir: string;
  const projectA = "C:\\projects\\a";
  const projectB = "C:\\projects\\b";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lasal-mcp-hmi-guard-"));
    process.env.LASAL_MCP_STATE_FILE = join(stateDir, "lasal-state.json");
    setCurrentProject(projectA);
    writeState({
      currentProject: projectA,
      hmiRuntimes: {
        [projectB]: {
          pid: process.pid,
          port: 9980,
          url: "http://127.0.0.1:9980/index.html",
          dataDir: "C:\\Temp\\lslvisu-b",
        },
      },
    });
  });

  afterEach(() => {
    setCurrentProject(null);
    delete process.env.LASAL_MCP_STATE_FILE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("refuses to start when another project owns the HMI runtime", async () => {
    const response = await startHmiRuntime({ action: "start", publishFirst: false });
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]?.text ?? "{}") as { ok?: boolean; error?: string; hints?: string[] };
    expect(body.ok).toBe(false);
    expect(`${body.error ?? ""} ${body.hints?.join(" ") ?? ""}`).toContain("another project");
  });

  it("does not globally kill an untracked runtime on stop", async () => {
    const response = await startHmiRuntime({ action: "stop" });
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]?.text ?? "{}") as { message?: string };
    expect(body.message).toContain("Nothing was stopped");
  });
});
