import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { completeClassNames, completeStationNames } from "../src/utils/completions.js";
import { writeState } from "../src/state.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("Argument Completions", () => {
  beforeEach(() => {
    writeState({ currentProject: FIXTURES });
  });

  afterEach(() => {
    writeState({ currentProject: null });
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
