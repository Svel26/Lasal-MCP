import { describe, it, expect } from "vitest";
import { findForeignAppHandles, type Class2HandleInfo } from "../src/utils/engine.js";

describe("process ownership", () => {
  const handles: Class2HandleInfo[] = [
    { pid: 1, lcpPath: "C:\\projects\\alpha\\Stations\\PLC\\Alpha.lcp", title: "Alpha" },
    { pid: 2, lcpPath: "C:\\projects\\beta\\Stations\\PLC\\Beta.lcp", title: "Beta" },
    { pid: 3, lcpPath: null, title: "Untitled - LASAL CLASS 2" },
  ];

  it("excludes instances under the target project directory", () => {
    const foreign = findForeignAppHandles(handles, { projectDir: "C:\\projects\\alpha" });
    expect(foreign.map((h) => h.pid)).toEqual([2, 3]);
  });

  it("excludes the exact target .lcp", () => {
    const foreign = findForeignAppHandles(handles, {
      lcpPath: "C:\\projects\\alpha\\Stations\\PLC\\Alpha.lcp",
    });
    expect(foreign.map((h) => h.pid)).toEqual([2, 3]);
  });

  it("treats a process without a project file as foreign", () => {
    const foreign = findForeignAppHandles(handles, { projectDir: "C:\\projects\\alpha" });
    expect(foreign.some((h) => h.pid === 3)).toBe(true);
  });

  it("returns nothing when no scope is known (legacy: caller owns everything)", () => {
    expect(findForeignAppHandles(handles, {})).toEqual([]);
  });

  it("does not confuse sibling projects with a shared prefix", () => {
    const foreign = findForeignAppHandles(
      [
        { pid: 4, lcpPath: "C:\\projects\\alpha2\\Stations\\PLC\\Alpha2.lcp", title: "" },
        { pid: 5, lcpPath: "C:\\projects\\alpha\\Stations\\PLC\\Alpha.lcp", title: "" },
      ],
      { projectDir: "C:\\projects\\alpha" },
    );
    expect(foreign.map((h) => h.pid)).toEqual([4]);
  });
});
