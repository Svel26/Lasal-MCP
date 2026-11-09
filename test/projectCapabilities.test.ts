import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectProjectShape } from "../src/core/project/capabilities.js";
import { clearProjectContextCache, resolveProjectContext } from "../src/core/project/context.js";

describe("project capability detection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lasal-mcp-capabilities-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function touch(name: string): void {
    writeFileSync(join(dir, name), "");
  }

  it("detects a CLASS 2-only project", () => {
    touch("PLC.lcp");
    const shape = detectProjectShape(dir);
    expect(shape.capabilities).toMatchObject({ class2: true, visu: false, screen: false });
    expect(shape.recommendedProfile).toBe("class2");
  });

  it("detects a VISU-only project", () => {
    touch("HMI.lvp");
    const shape = detectProjectShape(dir);
    expect(shape.capabilities).toMatchObject({ class2: false, visu: true, screen: false });
    expect(shape.recommendedProfile).toBe("visu");
  });

  it("detects a SCREEN-only project", () => {
    touch("Panel.lpr");
    const shape = detectProjectShape(dir);
    expect(shape.capabilities).toMatchObject({ class2: false, visu: false, screen: true });
    expect(shape.recommendedProfile).toBe("screen");
  });

  it("recommends the solution profile for mixed projects", () => {
    touch("PLC.lcp");
    touch("HMI.lvp");
    expect(detectProjectShape(dir).recommendedProfile).toBe("solution");

    touch("Panel.lpr");
    expect(detectProjectShape(dir).recommendedProfile).toBe("solution");
  });

  it("returns a project context with capabilities and a stable id", () => {
    touch("PLC.lcp");
    const first = resolveProjectContext(dir);
    const second = resolveProjectContext(dir);
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;

    expect(first.id).toBe(second.id);
    expect(first.capabilities.class2).toBe(true);
    expect(first.recommendedProfile).toBe("class2");
  });

  it("caches the context and invalidates on demand", () => {
    touch("PLC.lcp");
    const first = resolveProjectContext(dir);
    const second = resolveProjectContext(dir);
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;
    expect(second).toBe(first);

    touch("HMI.lvp");
    clearProjectContextCache(dir);
    const third = resolveProjectContext(dir);
    expect("error" in third).toBe(false);
    if ("error" in third) return;
    expect(third).not.toBe(first);
    expect(third.recommendedProfile).toBe("solution");
    expect(third.capabilities.visu).toBe(true);
  });
});
