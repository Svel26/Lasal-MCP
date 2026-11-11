import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { assertUnchanged, FileChangedError, stampFile, withProjectWriteLock } from "../src/core/project/locks.js";

describe("project write lock and file stamps", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lasal-mcp-lock-test-"));
    process.env.LASAL_MCP_LOCK_DIR = join(dir, "locks");
  });

  afterEach(() => {
    delete process.env.LASAL_MCP_LOCK_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("serializes mutating work for one project", async () => {
    let active = 0;
    let maxActive = 0;
    const projectId = "test-project";
    const task = () =>
      withProjectWriteLock(projectId, "test.action", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });

    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it("releases the lock when the action throws", async () => {
    const projectId = "test-throwing";
    await expect(
      withProjectWriteLock(projectId, "test.action", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await withProjectWriteLock(projectId, "test.action", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("detects a file changed since it was stamped", () => {
    const file = join(dir, "class.st");
    writeFileSync(file, "original", "latin1");
    const stamp = stampFile(file);
    assertUnchanged(stamp);

    writeFileSync(file, "changed-and-longer", "latin1");
    expect(() => assertUnchanged(stamp)).toThrow(FileChangedError);
  });

  it("detects a file that disappeared", () => {
    const file = join(dir, "class.st");
    writeFileSync(file, "original", "latin1");
    const stamp = stampFile(file);
    rmSync(file);

    expect(() => assertUnchanged(stamp)).toThrow(FileChangedError);
  });
});
