import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { completeClassNames, completeStationNames } from "../src/utils/completions.js";
import { writeState } from "../src/state.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("Argument Completions", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lasal-mcp-state-"));
    process.env.LASAL_MCP_STATE_FILE = join(stateDir, "lasal-state.json");
    writeState({ currentProject: FIXTURES });
  });

  afterEach(() => {
    delete process.env.LASAL_MCP_STATE_FILE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns all class names when prefix is empty", async () => {
    const names = await completeClassNames();
    expect(names).toContain("Motor");
  });

  it("filters class names matching a prefix (case-insensitive)", async () => {
    const names = await completeClassNames("mot");
    expect(names).toEqual(["Motor"]);

    const none = await completeClassNames("NonExistent");
    expect(none).toEqual([]);
  });

  it("returns station names from solution file", async () => {
    const stations = await completeStationNames();
    expect(Array.isArray(stations)).toBe(true);
  });

  it("returns empty arrays when no project is selected", async () => {
    writeState({ currentProject: null });
    expect(await completeClassNames()).toEqual([]);
    expect(await completeStationNames()).toEqual([]);
  });
});
