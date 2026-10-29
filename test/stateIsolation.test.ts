import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getActiveAgents,
  getLarsInstance,
  mergeLarsInstance,
  readState,
  setCurrentProject,
  setSharedProjectHint,
  updateState,
  writeState,
} from "../src/state.js";

const PROJECT_A = "C:\\projects\\alpha";
const PROJECT_B = "C:\\projects\\beta";

describe("state: per-agent project isolation", () => {
  let stateDir: string;
  let other: ChildProcess | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lasal-mcp-state-"));
    process.env.LASAL_MCP_STATE_FILE = join(stateDir, "lasal-state.json");
    setCurrentProject(null);
  });

  afterEach(() => {
    setCurrentProject(null);
    delete process.env.LASAL_MCP_STATE_FILE;
    other?.kill();
    other = undefined;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function startForeignAgent(): number {
    other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    if (!other.pid) throw new Error("could not spawn helper process");
    return other.pid;
  }

  it("inherits a legacy hint that has no owner pid", () => {
    writeState({ currentProject: PROJECT_A });
    expect(readState().currentProject).toBe(PROJECT_A);
  });

  it("does not inherit a hint owned by a live process", () => {
    const pid = startForeignAgent();
    writeState({ currentProject: PROJECT_A, currentProjectOwnerPid: pid });
    expect(readState().currentProject).toBeNull();
  });

  it("inherits the hint once its owner is gone", async () => {
    const pid = startForeignAgent();
    writeState({ currentProject: PROJECT_A, currentProjectOwnerPid: pid });
    const child = other!;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
    expect(readState().currentProject).toBe(PROJECT_A);
  });

  it("keeps this process's selection even when another agent updates the hint", () => {
    setCurrentProject(PROJECT_B);
    const pid = startForeignAgent();
    writeState({ currentProject: PROJECT_A, currentProjectOwnerPid: pid });
    expect(readState().currentProject).toBe(PROJECT_B);
  });

  it("records the selection for status without leaking it into unrelated writes", () => {
    setCurrentProject(PROJECT_B);
    setSharedProjectHint(PROJECT_B);

    // A LARS bookkeeping write from this agent must not move the shared hint of
    // another agent that selected in the meantime.
    writeState({ currentProject: PROJECT_A, currentProjectOwnerPid: startForeignAgent() });
    updateState((s) => {
      mergeLarsInstance(s, { name: "PLC", onlinePort: 2004 });
    });

    expect(readState().currentProject).toBe(PROJECT_B);
    expect(getLarsInstance(readState(), "PLC")?.onlinePort).toBe(2004);
  });

  it("does not lose records written concurrently by another agent", () => {
    updateState((s) => mergeLarsInstance(s, { name: "PLC", onlinePort: 2004 }));
    // Simulate another process having written between our read and our write:
    // updateState re-reads under the lock, so the earlier record survives.
    updateState((s) => mergeLarsInstance(s, { name: "HMI", onlinePort: 2014 }));

    const state = readState();
    expect(getLarsInstance(state, "PLC")?.onlinePort).toBe(2004);
    expect(getLarsInstance(state, "HMI")?.onlinePort).toBe(2014);
  });

  it("prunes dead agent records from getActiveAgents", () => {
    writeState({
      currentProject: null,
      agentProjects: {
        999_999: { project: PROJECT_A, since: Date.now() },
        [String(process.pid)]: { project: PROJECT_B, since: Date.now() },
      },
    });

    const agents = getActiveAgents();
    expect(agents.some((a) => a.pid === 999_999)).toBe(false);
    expect(agents.some((a) => a.isSelf && a.project === PROJECT_B)).toBe(true);
  });
});
